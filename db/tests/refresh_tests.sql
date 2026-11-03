-- P1-15: tests for refresh_contribution_metrics. Runs in one transaction that is rolled back.
-- Needs schema files 01-06, 10_refresh_metrics.sql and the synthetic seed.
--   podman exec -i cc-postgres psql -U codecollab -q < db/tests/refresh_tests.sql
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- A row of contribution_metrics as text, and the same row computed live, to compare in one step.
CREATE TEMP VIEW live AS
SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM member_contribution_v;
CREATE TEMP VIEW stored AS
SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM contribution_metrics;

CALL refresh_contribution_metrics();

DO $$
DECLARE
    p1 BIGINT; p2 BIGINT; victim RECORD; n_before BIGINT; snap_other TEXT;
BEGIN
    SELECT min(project_id), max(project_id) INTO p1, p2 FROM member_contribution_v;

    -- 1. A full refresh matches the live view exactly, in both directions.
    IF EXISTS ((SELECT * FROM stored EXCEPT ALL SELECT * FROM live) UNION ALL (SELECT * FROM live EXCEPT ALL SELECT * FROM stored)) THEN
        RAISE EXCEPTION 'FAIL full refresh does not match member_contribution_v';
    END IF;
    RAISE NOTICE 'pass  a full refresh matches the live view';

    -- 2. Drift is corrected: tamper with one row, refresh its project, and it is right again.
    SELECT project_id, user_id INTO victim FROM contribution_metrics WHERE project_id = p1 ORDER BY user_id LIMIT 1;
    UPDATE contribution_metrics SET commits = commits + 100, score = score + 100
     WHERE project_id = victim.project_id AND user_id = victim.user_id;
    CALL refresh_contribution_metrics(p1);
    IF (SELECT score FROM contribution_metrics WHERE project_id = victim.project_id AND user_id = victim.user_id)
       <> contribution_score(victim.user_id, victim.project_id) THEN
        RAISE EXCEPTION 'FAIL drift was not corrected';
    END IF;
    RAISE NOTICE 'pass  drift is corrected';

    -- 3. A single-project refresh leaves every other project untouched, including a drifted row there.
    CALL refresh_contribution_metrics();
    UPDATE contribution_metrics SET commits = commits + 7 WHERE project_id = p2;
    SELECT string_agg(s::text, ';' ORDER BY s.user_id) INTO snap_other FROM stored s WHERE project_id = p2;
    IF snap_other IS NULL THEN RAISE EXCEPTION 'FAIL project % has no metrics rows to protect', p2; END IF;
    CALL refresh_contribution_metrics(p1);
    IF (SELECT string_agg(s::text, ';' ORDER BY s.user_id) FROM stored s WHERE project_id = p2) IS DISTINCT FROM snap_other THEN
        RAISE EXCEPTION 'FAIL refreshing project % changed project %', p1, p2;
    END IF;
    RAISE NOTICE 'pass  a single-project refresh leaves other projects alone';

    -- 4. Idempotent: refreshing twice gives the same rows.
    CALL refresh_contribution_metrics();
    SELECT count(*) INTO n_before FROM contribution_metrics;
    CALL refresh_contribution_metrics();
    IF (SELECT count(*) FROM contribution_metrics) <> n_before
       OR EXISTS ((SELECT * FROM stored EXCEPT ALL SELECT * FROM live) UNION ALL (SELECT * FROM live EXCEPT ALL SELECT * FROM stored)) THEN
        RAISE EXCEPTION 'FAIL a second refresh changed the result';
    END IF;
    RAISE NOTICE 'pass  a refresh is idempotent';

    -- 5. A member removed from every team of a project loses their row at the next refresh.
    SELECT t.project_id, tm.user_id INTO victim
      FROM teams t JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id <> t.lead_id ORDER BY t.project_id, tm.user_id LIMIT 1;
    DELETE FROM team_members tm USING teams t
     WHERE tm.team_id = t.id AND t.project_id = victim.project_id AND tm.user_id = victim.user_id;
    CALL refresh_contribution_metrics(victim.project_id);
    IF EXISTS (SELECT 1 FROM contribution_metrics WHERE project_id = victim.project_id AND user_id = victim.user_id) THEN
        RAISE EXCEPTION 'FAIL a removed member still has a metrics row';
    END IF;
    RAISE NOTICE 'pass  a removed member''s row disappears';

    -- 6. An unknown project is an error, not a silent no-op.
    BEGIN
        CALL refresh_contribution_metrics(999999999);
        RAISE EXCEPTION 'FAIL an unknown project was accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%does not exist%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'pass  an unknown project is refused';
END $$;

\echo '=== ALL REFRESH TESTS PASSED'
ROLLBACK;
