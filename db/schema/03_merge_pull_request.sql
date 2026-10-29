-- P1-09: merge a pull request as one atomic unit of work.
--
-- Everything below runs inside the caller's transaction (or, in autocommit mode, the
-- single implicit transaction of the CALL). If any step raises, Postgres undoes all of
-- it: the PR status, the closed issues, the audit rows and the metric update.
--
-- Usage:  CALL merge_pull_request(<pr_id>, <merger_user_id>);
--         CALL merge_pull_request(<pr_id>, <merger_user_id>, TRUE);   -- demo: forced failure

CREATE OR REPLACE PROCEDURE merge_pull_request(
    p_pr_id             BIGINT,
    p_merger_id         BIGINT,
    p_simulate_failure  BOOLEAN DEFAULT FALSE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_pr              pull_requests%ROWTYPE;
    v_project_id      BIGINT;
    v_project_status  TEXT;
    v_closed_ids      BIGINT[];
BEGIN
    -- 1. Lock the PR row so two simultaneous merges cannot both succeed. A second caller
    --    waits here, then sees status = 'merged' and is rejected below.
    SELECT * INTO v_pr FROM pull_requests WHERE id = p_pr_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'merge_pull_request: pull request % does not exist', p_pr_id;
    END IF;

    -- 2. Validate. Each check has its own message so the application can show it.
    IF v_pr.status <> 'approved' THEN
        RAISE EXCEPTION 'merge_pull_request: pull request % is "%", only approved pull requests can be merged',
            p_pr_id, v_pr.status;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pr_reviews
                   WHERE pull_request_id = p_pr_id AND verdict = 'approved') THEN
        RAISE EXCEPTION 'merge_pull_request: pull request % has no approving review', p_pr_id;
    END IF;

    IF EXISTS (SELECT 1 FROM pr_reviews
               WHERE pull_request_id = p_pr_id AND verdict = 'changes_requested') THEN
        RAISE EXCEPTION 'merge_pull_request: pull request % has an unresolved change request', p_pr_id;
    END IF;

    SELECT r.project_id, p.status INTO v_project_id, v_project_status
    FROM repositories r JOIN projects p ON p.id = r.project_id
    WHERE r.id = v_pr.repository_id;

    IF v_project_status <> 'active' THEN
        RAISE EXCEPTION 'merge_pull_request: project % is %, merging is disabled', v_project_id, v_project_status;
    END IF;

    -- Only a team lead of the project or its mentor may merge.
    IF NOT (EXISTS (SELECT 1 FROM teams WHERE project_id = v_project_id AND lead_id = p_merger_id)
         OR EXISTS (SELECT 1 FROM projects WHERE id = v_project_id AND mentor_id = p_merger_id)) THEN
        RAISE EXCEPTION 'merge_pull_request: user % is not a lead or mentor of project %',
            p_merger_id, v_project_id;
    END IF;

    -- Tell the status-change audit trigger (P1-10) that this procedure writes its own,
    -- richer audit row, so the same change is not logged twice. The setting lasts only
    -- until the end of this transaction.
    PERFORM set_config('codecollab.merging', 'on', true);

    -- 3. Mark the PR merged.
    UPDATE pull_requests
       SET status = 'merged', merged_by = p_merger_id, merged_at = now(), updated_at = now()
     WHERE id = p_pr_id;

    -- 4. Close every still-open linked issue and log each closure. The subquery remembers
    --    the issue's old status, because RETURNING only shows the new one.
    WITH closed AS (
        UPDATE issues i
           SET status = 'closed', closed_at = now(), updated_at = now()
          FROM (SELECT l.issue_id, s.status AS old_status
                  FROM pr_issue_links l JOIN issues s ON s.id = l.issue_id
                 WHERE l.pull_request_id = p_pr_id AND s.status <> 'closed') x
         WHERE i.id = x.issue_id
        RETURNING i.id, x.old_status
    ), logged AS (
        INSERT INTO audit_log (entity_type, entity_id, action, old_status, new_status, actor_id, details)
        SELECT 'issue', c.id, 'close_via_pr', c.old_status, 'closed', p_merger_id,
               jsonb_build_object('pull_request_id', p_pr_id)
          FROM closed c
        RETURNING 1
    )
    SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_closed_ids FROM closed;

    -- 5. Audit row for the merge itself.
    INSERT INTO audit_log (entity_type, entity_id, action, old_status, new_status, actor_id, details)
    VALUES ('pull_request', p_pr_id, 'merge', 'approved', 'merged', p_merger_id,
            jsonb_build_object('repository_id', v_pr.repository_id,
                               'closed_issues', to_jsonb(v_closed_ids)));

    -- 6. Incremental metrics for the PR author. The full recomputation is the refresh
    --    procedure (P1-15); this keeps the dashboard current between refreshes.
    IF v_pr.author_id IS NOT NULL THEN
        INSERT INTO contribution_metrics (project_id, user_id, prs_merged, issues_closed)
        VALUES (v_project_id, v_pr.author_id, 1, coalesce(array_length(v_closed_ids, 1), 0))
        ON CONFLICT (project_id, user_id) DO UPDATE
            SET prs_merged    = contribution_metrics.prs_merged + 1,
                issues_closed = contribution_metrics.issues_closed + EXCLUDED.issues_closed,
                refreshed_at  = now();
    END IF;

    -- 7. Demonstration hook: fail after every write has happened, to prove they all vanish.
    IF p_simulate_failure THEN
        RAISE EXCEPTION 'merge_pull_request: simulated failure after all writes (demo)';
    END IF;
END;
$$;

COMMENT ON PROCEDURE merge_pull_request(BIGINT, BIGINT, BOOLEAN) IS
    'Atomically merges an approved pull request: status, linked issues, audit log, metrics.';
