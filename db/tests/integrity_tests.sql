-- P1-16: integrity test suite. Every test asserts; any failure stops the run with an error.
-- Runs inside one transaction that is rolled back, so the database is left unchanged.
-- Needs schema files 01-06, 10_refresh_metrics.sql (P1-15) and the synthetic seed.
--   podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/tests/integrity_tests.sql
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- expect_error(sql, sqlstate): passes only if running `sql` fails with that SQLSTATE.
CREATE FUNCTION pg_temp.expect_error(p_name text, p_sql text, p_state text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'FAIL %: expected error %, but the statement succeeded', p_name, p_state;
EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN
        RAISE NOTICE 'pass  %', p_name;
    ELSIF SQLERRM LIKE 'FAIL %' THEN
        RAISE;
    ELSE
        RAISE EXCEPTION 'FAIL %: expected error %, got % (%)', p_name, p_state, SQLSTATE, SQLERRM;
    END IF;
END;
$$;

-- expect_true(name, condition): passes only if the SQL expression is true.
CREATE FUNCTION pg_temp.expect_true(p_name text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
    EXECUTE 'SELECT (' || p_sql || ')' INTO ok;
    IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %: % is not true', p_name, p_sql; END IF;
    RAISE NOTICE 'pass  %', p_name;
END;
$$;

-- Fixtures: one active project with a team, its lead, a member and an author.
CREATE TEMP TABLE fx AS
SELECT p.id AS project, r.id AS repo, t.lead_id AS lead,
       (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id <> t.lead_id ORDER BY tm.user_id LIMIT 1) AS member,
       p.mentor_id AS mentor
FROM projects p JOIN repositories r ON r.project_id = p.id AND r.is_synthetic
JOIN teams t ON t.project_id = p.id
WHERE p.status = 'active' ORDER BY p.id LIMIT 1;

\echo '--- CHECK constraints (23514)'
SELECT pg_temp.expect_error('users.role must be a known role',
  $q$INSERT INTO users (email, full_name, password_hash, role) VALUES ('t1@x.test', 'T', 'h', 'admin')$q$, '23514');
SELECT pg_temp.expect_error('users.email must be lowercase',
  $q$INSERT INTO users (email, full_name, password_hash) VALUES ('Up@X.test', 'T', 'h')$q$, '23514');
SELECT pg_temp.expect_error('issues.priority must be known',
  format($q$INSERT INTO issues (repository_id, number, title, priority) VALUES (%s, 900001, 't', 'urgent')$q$, (SELECT repo FROM fx)), '23514');
SELECT pg_temp.expect_error('closed issue needs closed_at',
  format($q$INSERT INTO issues (repository_id, number, title, status) VALUES (%s, 900002, 't', 'closed')$q$, (SELECT repo FROM fx)), '23514');
SELECT pg_temp.expect_error('merged PR needs merged_at',
  format($q$INSERT INTO pull_requests (repository_id, number, title, status) VALUES (%s, 900003, 't', 'merged')$q$, (SELECT repo FROM fx)), '23514');
SELECT pg_temp.expect_error('commit sha must be hex',
  format($q$INSERT INTO commits (repository_id, sha, message, committed_at) VALUES (%s, 'XYZ', 'm', now())$q$, (SELECT repo FROM fx)), '23514');
SELECT pg_temp.expect_error('commit additions cannot be negative',
  format($q$INSERT INTO commits (repository_id, sha, message, additions, committed_at) VALUES (%s, 'abcdef1', 'm', -1, now())$q$, (SELECT repo FROM fx)), '23514');
SELECT pg_temp.expect_error('review verdict must be known',
  $q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) SELECT min(id), (SELECT lead FROM fx), 'maybe' FROM pull_requests$q$, '23514');
SELECT pg_temp.expect_error('label colour must be #rrggbb',
  format($q$INSERT INTO labels (project_id, name, color) VALUES (%s, 'x', 'red')$q$, (SELECT project FROM fx)), '23514');
SELECT pg_temp.expect_error('metrics cannot be negative',
  format($q$INSERT INTO contribution_metrics (project_id, user_id, commits) VALUES (%s, %s, -5)$q$, (SELECT project FROM fx), (SELECT lead FROM fx)), '23514');

\echo '--- UNIQUE (23505)'
SELECT pg_temp.expect_error('user email is unique',
  $q$INSERT INTO users (email, full_name, password_hash) SELECT email, 'dup', 'h' FROM users LIMIT 1$q$, '23505');
SELECT pg_temp.expect_error('issue number unique per repository',
  $q$INSERT INTO issues (repository_id, number, title) SELECT repository_id, number, 'dup' FROM issues LIMIT 1$q$, '23505');
SELECT pg_temp.expect_error('one review per reviewer per PR',
  $q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) SELECT pull_request_id, reviewer_id, 'commented' FROM pr_reviews WHERE reviewer_id IS NOT NULL LIMIT 1$q$, '23505');

\echo '--- NOT NULL (23502) and foreign keys (23503)'
SELECT pg_temp.expect_error('issue title is required',
  format($q$INSERT INTO issues (repository_id, number, title) VALUES (%s, 900004, NULL)$q$, (SELECT repo FROM fx)), '23502');
SELECT pg_temp.expect_error('commit needs an existing repository',
  $q$INSERT INTO commits (repository_id, sha, message, committed_at) VALUES (999999999, 'abcdef1', 'm', now())$q$, '23503');

\echo '--- ON DELETE policy (P1-08)'
SELECT pg_temp.expect_error('RESTRICT: a mentor with projects cannot be deleted',
  format('DELETE FROM users WHERE id = %s', (SELECT mentor FROM fx)), '23503');
SAVEPOINT del;
CREATE TEMP TABLE before_del AS SELECT (SELECT count(*) FROM commits) AS commits, (SELECT count(*) FROM commits WHERE author_id = (SELECT member FROM fx)) AS theirs;
DELETE FROM users WHERE id = (SELECT member FROM fx);
SELECT pg_temp.expect_true('SET NULL: commits survive their author', '(SELECT count(*) FROM commits) = (SELECT commits FROM before_del)');
SELECT pg_temp.expect_true('CASCADE: membership rows go with the user', format('NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = %s)', (SELECT member FROM fx)));
ROLLBACK TO del;
SAVEPOINT delp;
DELETE FROM projects WHERE id = (SELECT project FROM fx);
SELECT pg_temp.expect_true('CASCADE: deleting a project removes its repositories and commits',
  format('NOT EXISTS (SELECT 1 FROM repositories WHERE id = %s) AND NOT EXISTS (SELECT 1 FROM commits WHERE repository_id = %s)', (SELECT repo FROM fx), (SELECT repo FROM fx)));
ROLLBACK TO delp;

\echo '--- Triggers (P1-10)'
SELECT pg_temp.expect_error('author cannot review own PR',
  $q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) SELECT id, author_id, 'approved' FROM pull_requests WHERE author_id IS NOT NULL LIMIT 1$q$, '23514');
SAVEPOINT aud;
CREATE TEMP TABLE pr1 AS SELECT id FROM pull_requests WHERE status = 'open' ORDER BY id LIMIT 1;
UPDATE pull_requests SET status = 'closed' FROM (SELECT set_config('codecollab.actor_id', (SELECT lead FROM fx)::text, true)) a WHERE id = (SELECT id FROM pr1);
SELECT pg_temp.expect_true('status change is audited with its actor',
  format($q$EXISTS (SELECT 1 FROM audit_log WHERE entity_type = 'pull_request' AND entity_id = %s AND new_status = 'closed' AND actor_id = %s)$q$, (SELECT id FROM pr1), (SELECT lead FROM fx)));
ROLLBACK TO aud;

\echo '--- merge_pull_request (P1-09)'
CREATE TEMP TABLE m AS
SELECT p.id AS pr, t.lead_id AS lead FROM pull_requests p
JOIN repositories r ON r.id = p.repository_id AND r.github_url IS NULL
JOIN projects pj ON pj.id = r.project_id AND pj.status = 'active'
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'approved' AND NOT EXISTS (SELECT 1 FROM pr_reviews v WHERE v.pull_request_id = p.id AND v.verdict = 'changes_requested')
ORDER BY p.id LIMIT 1;
CREATE TEMP TABLE audit_before AS SELECT count(*) AS n FROM audit_log;
SELECT pg_temp.expect_error('forced failure raises',
  format('CALL merge_pull_request(%s, %s, true)', (SELECT pr FROM m), (SELECT lead FROM m)), 'P0001');
SELECT pg_temp.expect_true('forced failure leaves the PR approved',
  format($q$(SELECT status FROM pull_requests WHERE id = %s) = 'approved'$q$, (SELECT pr FROM m)));
SELECT pg_temp.expect_true('forced failure writes no audit rows', '(SELECT count(*) FROM audit_log) = (SELECT n FROM audit_before)');
SELECT pg_temp.expect_error('a student cannot merge',
  format('CALL merge_pull_request(%s, %s)', (SELECT pr FROM m), (SELECT member FROM fx)), 'P0001');
SELECT format('CALL merge_pull_request(%s, %s)', pr, lead) FROM m \gexec
SELECT pg_temp.expect_true('a lead merges the PR', format($q$(SELECT status FROM pull_requests WHERE id = %s) = 'merged'$q$, (SELECT pr FROM m)));
SELECT pg_temp.expect_true('the merge is audited', format($q$EXISTS (SELECT 1 FROM audit_log WHERE action = 'merge' AND entity_id = %s)$q$, (SELECT pr FROM m)));
SELECT pg_temp.expect_error('a merged PR cannot be merged again',
  format('CALL merge_pull_request(%s, %s)', (SELECT pr FROM m), (SELECT lead FROM m)), 'P0001');

\echo '--- Views and scoring (P1-11, P1-12, P1-15)'
SELECT pg_temp.expect_true('dashboard commit totals equal the commits table',
  '(SELECT sum(total_commits) FROM project_dashboard_v) = (SELECT count(*) FROM commits c JOIN repositories r ON r.id = c.repository_id)');
SELECT pg_temp.expect_true('view score equals contribution_score()',
  'NOT EXISTS (SELECT 1 FROM member_contribution_v v WHERE v.score <> contribution_score(v.user_id, v.project_id))');
CALL refresh_contribution_metrics();
SELECT pg_temp.expect_true('refreshed metrics equal the live view',
  'NOT EXISTS (SELECT project_id, user_id, score FROM contribution_metrics EXCEPT SELECT project_id, user_id, score FROM member_contribution_v)');

\echo '=== ALL TESTS PASSED'
ROLLBACK;
