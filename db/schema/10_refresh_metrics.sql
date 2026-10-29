-- P1-15: rebuild contribution_metrics from the live tables.
-- The counts and the score come from contribution_counts() and score_from_counts()
-- (05_contribution_score.sql), so the rules exist in exactly one place.
--
-- Usage:  CALL refresh_contribution_metrics();        -- every project
--         CALL refresh_contribution_metrics(3);       -- one project
--
-- Delete and re-insert inside the caller's transaction: readers see either the old rows
-- or the new ones, never a half-refreshed table. It also corrects any drift from the
-- incremental updates made by merge_pull_request (P1-09).

CREATE OR REPLACE PROCEDURE refresh_contribution_metrics(p_project_id BIGINT DEFAULT NULL)
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows INTEGER;
BEGIN
    DELETE FROM contribution_metrics
     WHERE p_project_id IS NULL OR project_id = p_project_id;

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

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE NOTICE 'refresh_contribution_metrics: % row(s) written', v_rows;
END;
$$;
