-- P1-15: rebuild contribution_metrics from the live tables.
-- The counts and the score come from contribution_counts() and score_from_counts()
-- (05_contribution_score.sql, which must be applied first), so the rules exist in exactly one place.
--
-- Usage:  CALL refresh_contribution_metrics();        -- every project
--         CALL refresh_contribution_metrics(3);       -- one project
--
-- Run it by hand or on a schedule, and after bulk loads (the seed, GitHub ingestion); not on a
-- request path, since a full refresh computes the counts for every member. merge_pull_request (P1-09)
-- keeps prs_merged and issues_closed current between refreshes, but not commits, reviews or the
-- score; those catch up at the next refresh.
--
-- Delete and re-insert inside the caller's transaction: readers see either the old rows
-- or the new ones, never a half-refreshed table. It also corrects any drift from the
-- incremental updates made by merge_pull_request.

CREATE OR REPLACE PROCEDURE refresh_contribution_metrics(p_project_id BIGINT DEFAULT NULL)
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted INTEGER;
    v_written INTEGER;
BEGIN
    IF p_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id = p_project_id) THEN
        RAISE EXCEPTION 'refresh_contribution_metrics: project % does not exist', p_project_id;
    END IF;

    -- merge_pull_request upserts into this table. Without the lock, a merge that inserts a new row
    -- between the DELETE and the INSERT below makes the INSERT fail with a duplicate key. This mode
    -- blocks other writers (they wait for the refresh to commit) but not readers.
    LOCK TABLE contribution_metrics IN SHARE ROW EXCLUSIVE MODE;

    DELETE FROM contribution_metrics
     WHERE p_project_id IS NULL OR project_id = p_project_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    INSERT INTO contribution_metrics
           (project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score, refreshed_at)
    SELECT m.project_id, m.user_id,
           c.commits, c.prs_opened, c.prs_merged, c.reviews_given, c.issues_closed,
           score_from_counts(c.commits, c.prs_merged, c.reviews_given, c.issues_closed),
           now()
    FROM (SELECT DISTINCT t.project_id, tm.user_id
            FROM teams t JOIN team_members tm ON tm.team_id = t.id
           WHERE p_project_id IS NULL OR t.project_id = p_project_id) m
    CROSS JOIN LATERAL (SELECT * FROM contribution_counts(m.user_id, m.project_id) OFFSET 0) c;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    RAISE NOTICE 'refresh_contribution_metrics: % row(s) deleted, % written', v_deleted, v_written;
END;
$$;
