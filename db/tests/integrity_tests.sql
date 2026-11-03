-- P1-16: integrity test suite. Every test asserts; any failure stops the run with an error.
-- Runs inside one transaction that is rolled back, so the database is left unchanged.
-- Needs schema files 01-06, 10_refresh_metrics.sql (P1-15) and the synthetic seed.
--   podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/tests/integrity_tests.sql
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- expect_error(name, sql, sqlstate, match): passes only if `sql` fails with that SQLSTATE and, when
-- `match` is given, with a constraint name or message LIKE `match`. The failure messages are raised
-- outside the handler, so a statement that wrongly succeeds can never be counted as a pass.
CREATE FUNCTION pg_temp.expect_error(p_name text, p_sql text, p_state text, p_match text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_failed boolean := false;
    v_state text; v_msg text; v_constraint text;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        v_failed := true;
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_constraint = CONSTRAINT_NAME;
    END;
    IF NOT v_failed THEN
        RAISE EXCEPTION 'FAIL %: expected error %, but the statement succeeded', p_name, p_state;
    END IF;
    IF v_state <> p_state THEN
        RAISE EXCEPTION 'FAIL %: expected error %, got % (%)', p_name, p_state, v_state, v_msg;
    END IF;
    IF p_match IS NOT NULL AND coalesce(v_constraint, '') NOT LIKE p_match AND v_msg NOT LIKE p_match THEN
        RAISE EXCEPTION 'FAIL %: expected %, got constraint "%" (%)', p_name, p_match, v_constraint, v_msg;
    END IF;
    RAISE NOTICE 'pass  %', p_name;
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

\echo '--- The helpers themselves'
DO $$ BEGIN
    PERFORM pg_temp.expect_error('self-check', 'SELECT 1', 'P0001');
    RAISE EXCEPTION 'expect_error passed a statement that succeeded';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FAIL self-check:%' THEN RAISE; END IF;
    RAISE NOTICE 'pass  expect_error fails when the statement succeeds';
END $$;

-- Fixtures: one active project with a team, its lead, a member who is not the lead, and its mentor,
-- and an approved PR in that same project that can be merged.
CREATE TEMP TABLE fx AS
SELECT p.id AS project, r.id AS repo, t.lead_id AS lead,
       (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id <> t.lead_id ORDER BY tm.user_id LIMIT 1) AS member,
       p.mentor_id AS mentor,
       (SELECT x.id FROM pull_requests x
         WHERE x.repository_id = r.id AND x.status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM pr_reviews v WHERE v.pull_request_id = x.id AND v.verdict = 'changes_requested')
         ORDER BY x.id LIMIT 1) AS pr
FROM projects p JOIN repositories r ON r.project_id = p.id AND r.is_synthetic AND r.github_url IS NULL
JOIN teams t ON t.project_id = p.id
WHERE p.status = 'active'
  AND EXISTS (SELECT 1 FROM pull_requests x WHERE x.repository_id = r.id AND x.status = 'approved'
                AND NOT EXISTS (SELECT 1 FROM pr_reviews v WHERE v.pull_request_id = x.id AND v.verdict = 'changes_requested'))
ORDER BY p.id LIMIT 1;
SELECT pg_temp.expect_true('fixtures found (project, lead, member, mentor, mergeable PR)',
  '(SELECT count(*) FROM fx WHERE project IS NOT NULL AND lead IS NOT NULL AND member IS NOT NULL AND mentor IS NOT NULL AND pr IS NOT NULL
      AND (SELECT author_id FROM pull_requests WHERE id = fx.pr) IS DISTINCT FROM mentor) = 1');

\echo '--- CHECK constraints (23514)'
SELECT pg_temp.expect_error('users.role must be a known role',
  $q$INSERT INTO users (email, full_name, password_hash, role) VALUES ('t1@x.test', 'T', 'h', 'admin')$q$, '23514', 'users_role_check');
SELECT pg_temp.expect_error('users.email must be lowercase',
  $q$INSERT INTO users (email, full_name, password_hash) VALUES ('Up@X.test', 'T', 'h')$q$, '23514', 'users_email_lowercase');
SELECT pg_temp.expect_error('issues.priority must be known',
  format($q$INSERT INTO issues (repository_id, number, title, priority) VALUES (%s, 900001, 't', 'urgent')$q$, (SELECT repo FROM fx)), '23514', 'issues_priority_check');
SELECT pg_temp.expect_error('closed issue needs closed_at',
  format($q$INSERT INTO issues (repository_id, number, title, status) VALUES (%s, 900002, 't', 'closed')$q$, (SELECT repo FROM fx)), '23514', 'issues_check');
SELECT pg_temp.expect_error('merged PR needs merged_at',
  format($q$INSERT INTO pull_requests (repository_id, number, title, status) VALUES (%s, 900003, 't', 'merged')$q$, (SELECT repo FROM fx)), '23514', 'pull_requests_check');
SELECT pg_temp.expect_error('commit sha must be hex',
  format($q$INSERT INTO commits (repository_id, sha, message, committed_at) VALUES (%s, 'xyzxyzx', 'm', now())$q$, (SELECT repo FROM fx)), '23514', 'commits_sha_hex');
SELECT pg_temp.expect_error('commit additions cannot be negative',
  format($q$INSERT INTO commits (repository_id, sha, message, additions, committed_at) VALUES (%s, 'abcdef1', 'm', -1, now())$q$, (SELECT repo FROM fx)), '23514', 'commits_additions_check');
SELECT pg_temp.expect_error('review verdict must be known',
  format($q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) VALUES (%s, %s, 'maybe')$q$, (SELECT pr FROM fx), (SELECT mentor FROM fx)), '23514', 'pr_reviews_verdict_check');
SELECT pg_temp.expect_error('label colour must be #rrggbb',
  format($q$INSERT INTO labels (project_id, name, color) VALUES (%s, 'x', 'red')$q$, (SELECT project FROM fx)), '23514', 'labels_color_check');
SELECT pg_temp.expect_error('metrics cannot be negative',
  format($q$INSERT INTO contribution_metrics (project_id, user_id, commits) VALUES (%s, %s, -5)$q$, (SELECT project FROM fx), (SELECT lead FROM fx)), '23514', 'contribution_metrics_commits_check');

\echo '--- UNIQUE (23505)'
SELECT pg_temp.expect_error('user email is unique',
  $q$INSERT INTO users (email, full_name, password_hash) SELECT email, 'dup', 'h' FROM users LIMIT 1$q$, '23505', 'users_email_key');
SELECT pg_temp.expect_error('issue number unique per repository',
  $q$INSERT INTO issues (repository_id, number, title) SELECT repository_id, number, 'dup' FROM issues LIMIT 1$q$, '23505', 'issues_repository_id_number_key');
SELECT pg_temp.expect_error('one review per reviewer per PR',
  $q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) SELECT pull_request_id, reviewer_id, 'commented' FROM pr_reviews WHERE reviewer_id IS NOT NULL LIMIT 1$q$, '23505', 'pr_reviews_pull_request_id_reviewer_id_key');

\echo '--- NOT NULL (23502) and foreign keys (23503)'
SELECT pg_temp.expect_error('issue title is required',
  format($q$INSERT INTO issues (repository_id, number, title) VALUES (%s, 900004, NULL)$q$, (SELECT repo FROM fx)), '23502', '%"title"%');
SELECT pg_temp.expect_error('commit needs an existing repository',
  $q$INSERT INTO commits (repository_id, sha, message, committed_at) VALUES (999999999, 'abcdef1', 'm', now())$q$, '23503', 'commits_repository_id_fkey');

\echo '--- ON DELETE policy (P1-08)'
SELECT pg_temp.expect_error('RESTRICT: a mentor with projects cannot be deleted',
  format('DELETE FROM users WHERE id = %s', (SELECT mentor FROM fx)), '23503', 'projects_mentor_id_fkey');
SAVEPOINT del;
CREATE TEMP TABLE before_del AS
SELECT (SELECT count(*) FROM commits) AS commits,
       (SELECT count(*) FROM commits WHERE author_id = (SELECT member FROM fx)) AS theirs;
DELETE FROM users WHERE id = (SELECT member FROM fx);
SELECT pg_temp.expect_true('the member had commits to keep', '(SELECT theirs FROM before_del) > 0');
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
  $q$INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) SELECT id, author_id, 'approved' FROM pull_requests WHERE author_id IS NOT NULL LIMIT 1$q$, '23514', '%cannot review their own pull request%');
SAVEPOINT aud;
CREATE TEMP TABLE pr1 AS SELECT id FROM pull_requests WHERE status = 'open' ORDER BY id LIMIT 1;
UPDATE pull_requests SET status = 'closed' FROM (SELECT set_config('codecollab.actor_id', (SELECT lead FROM fx)::text, true)) a WHERE id = (SELECT id FROM pr1);
SELECT pg_temp.expect_true('status change is audited with its actor',
  format($q$EXISTS (SELECT 1 FROM audit_log WHERE entity_type = 'pull_request' AND entity_id = %s AND new_status = 'closed' AND actor_id = %s)$q$, (SELECT id FROM pr1), (SELECT lead FROM fx)));
ROLLBACK TO aud;

\echo '--- merge_pull_request (P1-09)'
-- Postgres undoes a failed statement as a whole, so what these tests show is that the procedure fails
-- only after doing all its writes, and that it never commits part-way: a COMMIT inside it would fail
-- here with 2D000 (invalid transaction termination) instead of the expected P0001.
CREATE TEMP TABLE audit_before AS SELECT count(*) AS n FROM audit_log;
SELECT pg_temp.expect_error('forced failure is raised after all writes',
  format('CALL merge_pull_request(%s, %s, true)', (SELECT pr FROM fx), (SELECT lead FROM fx)), 'P0001', '%simulated failure after all writes%');
SELECT pg_temp.expect_true('after the failure the PR is still approved',
  format($q$(SELECT status FROM pull_requests WHERE id = %s) = 'approved'$q$, (SELECT pr FROM fx)));
SELECT pg_temp.expect_true('after the failure no audit rows remain', '(SELECT count(*) FROM audit_log) = (SELECT n FROM audit_before)');
SELECT pg_temp.expect_error('a member of the project who is not its lead cannot merge',
  format('CALL merge_pull_request(%s, %s)', (SELECT pr FROM fx), (SELECT member FROM fx)), 'P0001', '%is not a lead or mentor%');
SELECT format('CALL merge_pull_request(%s, %s)', pr, lead) FROM fx \gexec
SELECT pg_temp.expect_true('a lead merges the PR', format($q$(SELECT status FROM pull_requests WHERE id = %s) = 'merged'$q$, (SELECT pr FROM fx)));
SELECT pg_temp.expect_true('the merge is audited', format($q$EXISTS (SELECT 1 FROM audit_log WHERE action = 'merge' AND entity_id = %s)$q$, (SELECT pr FROM fx)));
SELECT pg_temp.expect_error('a merged PR cannot be merged again',
  format('CALL merge_pull_request(%s, %s)', (SELECT pr FROM fx), (SELECT lead FROM fx)), 'P0001', '%only approved pull requests can be merged%');

\echo '--- Views and scoring (P1-11, P1-12, P1-15)'
SELECT pg_temp.expect_true('dashboard commit totals equal the commits table',
  '(SELECT sum(total_commits) FROM project_dashboard_v) = (SELECT count(*) FROM commits c JOIN repositories r ON r.id = c.repository_id)');
SELECT pg_temp.expect_true('view score equals contribution_score()',
  'NOT EXISTS (SELECT 1 FROM member_contribution_v v WHERE v.score <> contribution_score(v.user_id, v.project_id))');
-- Pins the weights (commit 1, merged PR 5, review 3, closed issue 2) with a calculation written out by hand.
SELECT pg_temp.expect_true('top scorer''s score equals a hand-written calculation', $q$(SELECT
  (SELECT v.score FROM member_contribution_v v WHERE v.user_id = t.u AND v.project_id = t.p) =
    (SELECT count(*) FROM commits c JOIN repositories r ON r.id = c.repository_id WHERE r.project_id = t.p AND c.author_id = t.u)
  + 5 * (SELECT count(*) FROM pull_requests x JOIN repositories r ON r.id = x.repository_id WHERE r.project_id = t.p AND x.author_id = t.u AND x.status = 'merged')
  + 3 * (SELECT count(*) FROM pr_reviews rv JOIN pull_requests x ON x.id = rv.pull_request_id JOIN repositories r ON r.id = x.repository_id WHERE r.project_id = t.p AND rv.reviewer_id = t.u)
  + 2 * (SELECT count(DISTINCT l.issue_id) FROM pr_issue_links l JOIN pull_requests x ON x.id = l.pull_request_id JOIN repositories r ON r.id = x.repository_id JOIN issues i ON i.id = l.issue_id
          WHERE r.project_id = t.p AND x.author_id = t.u AND x.status = 'merged' AND i.status = 'closed')
  FROM (SELECT user_id AS u, project_id AS p FROM member_contribution_v ORDER BY score DESC, user_id LIMIT 1) t)$q$);
CALL refresh_contribution_metrics();
SELECT pg_temp.expect_true('refreshed metrics equal the live view, in both directions and in every column', $q$NOT EXISTS (
  (SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM contribution_metrics
   EXCEPT ALL
   SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM member_contribution_v)
  UNION ALL
  (SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM member_contribution_v
   EXCEPT ALL
   SELECT project_id, user_id, commits, prs_opened, prs_merged, reviews_given, issues_closed, score FROM contribution_metrics))$q$);

\echo '=== ALL TESTS PASSED'
ROLLBACK;
