-- ON DELETE demonstration (P1-08). Everything runs inside one transaction that is
-- rolled back at the end, so no data is lost.
\set ON_ERROR_STOP off
\pset pager off
BEGIN;

\echo '=== baseline'
SELECT (SELECT count(*) FROM users)   AS users,   (SELECT count(*) FROM commits) AS commits,
       (SELECT count(*) FROM issues)  AS issues,  (SELECT count(*) FROM pull_requests) AS prs;

\echo '=== 1. SET NULL: delete a student. Their commits stay, author_id becomes NULL.'
SELECT id AS uid FROM users WHERE email = 'user19@seed.codecollab.test' \gset
SELECT count(*) AS theirs FROM commits WHERE author_id = :uid \gset
SELECT count(*) AS null_before FROM commits WHERE author_id IS NULL \gset
DELETE FROM users WHERE id = :uid;
SELECT (SELECT count(*) FROM commits) AS total_commits_unchanged,
       (SELECT count(*) FROM commits WHERE author_id IS NULL) - :null_before AS newly_anonymous,
       :theirs AS expected_anonymous;

\echo '=== 2. RESTRICT: delete a mentor who still has projects. This must FAIL.'
SAVEPOINT s1;
DELETE FROM users WHERE email = 'user01@seed.codecollab.test';
ROLLBACK TO s1;

\echo '=== 3. CASCADE: delete one project. Everything beneath it goes.'
SELECT p.id AS pid FROM projects p JOIN repositories r ON r.project_id = p.id
WHERE r.is_synthetic ORDER BY p.id LIMIT 1 \gset
SELECT (SELECT count(*) FROM teams WHERE project_id = :pid) AS teams,
       (SELECT count(*) FROM repositories WHERE project_id = :pid) AS repos,
       (SELECT count(*) FROM commits c JOIN repositories r ON r.id = c.repository_id WHERE r.project_id = :pid) AS commits,
       (SELECT count(*) FROM issues i JOIN repositories r ON r.id = i.repository_id WHERE r.project_id = :pid) AS issues,
       (SELECT count(*) FROM pull_requests p JOIN repositories r ON r.id = p.repository_id WHERE r.project_id = :pid) AS prs;
DELETE FROM projects WHERE id = :pid;
SELECT (SELECT count(*) FROM teams WHERE project_id = :pid) AS teams,
       (SELECT count(*) FROM repositories WHERE project_id = :pid) AS repos,
       (SELECT count(*) FROM commits) AS commits_left_overall,
       (SELECT count(*) FROM issues) AS issues_left_overall;

ROLLBACK;
\echo '=== after ROLLBACK: baseline restored'
SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM commits) AS commits,
       (SELECT count(*) FROM issues) AS issues, (SELECT count(*) FROM pull_requests) AS prs;
