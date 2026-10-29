\set ON_ERROR_STOP off
\pset pager off
BEGIN;

-- An open PR, its author, and a team lead of its project to act as the "actor".
SELECT p.id AS pr, p.author_id AS author, t.lead_id AS lead, r.project_id AS proj
FROM pull_requests p JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'open' AND p.author_id IS NOT NULL ORDER BY p.id LIMIT 1 \gset
SELECT id AS iss FROM issues WHERE status = 'open' ORDER BY id LIMIT 1 \gset

\echo '=== A. STATUS AUDIT'
SELECT set_config('codecollab.actor_id', :'lead', true) \gset x_
\echo '--- A1. change PR status open -> closed: one row, with the actor'
UPDATE pull_requests SET status = 'closed', updated_at = now() WHERE id = :pr;
SELECT entity_type, action, old_status, new_status, actor_id = :lead AS actor_ok FROM audit_log;
\echo '--- A2. change title only: no new row'
UPDATE pull_requests SET title = title || '!' WHERE id = :pr;
\echo '--- A3. set status to the value it already has: no new row'
UPDATE pull_requests SET status = 'closed' WHERE id = :pr;
SELECT count(*) AS audit_rows_still_1 FROM audit_log;
\echo '--- A4. issue status change is audited too'
UPDATE issues SET status = 'in_progress', updated_at = now() WHERE id = :iss AND status = 'open';
SELECT entity_type, old_status, new_status FROM audit_log ORDER BY id;

\echo '=== B. MERGE DOES NOT DOUBLE-LOG'
DELETE FROM audit_log;
SELECT p.id AS apr, t.lead_id AS mlead
FROM pull_requests p JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN projects pj ON pj.id = r.project_id AND pj.status = 'active'
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'approved' AND EXISTS (SELECT 1 FROM pr_issue_links l JOIN issues i ON i.id = l.issue_id
      WHERE l.pull_request_id = p.id AND i.status <> 'closed') ORDER BY p.id LIMIT 1 \gset
CALL merge_pull_request(:apr, :mlead);
SELECT action, count(*) FROM audit_log GROUP BY action ORDER BY action;
\echo '(expected: close_via_pr 1+, merge 1, and NO status_change rows)'

\echo '=== C. SELF-REVIEW'
\echo '--- C1. author reviews own PR: must fail'
SAVEPOINT c1;
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) VALUES (:pr, :author, 'approved');
ROLLBACK TO c1;
\echo '--- C2. review with NULL reviewer: must fail'
SAVEPOINT c2;
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) VALUES (:pr, NULL, 'approved');
ROLLBACK TO c2;
\echo '--- C3. someone else reviews: must succeed'
SELECT user_id AS other FROM team_members tm JOIN teams t ON t.id = tm.team_id
WHERE t.project_id = :proj AND tm.user_id <> :author ORDER BY user_id LIMIT 1 \gset
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) VALUES (:pr, :other, 'commented');
SELECT reviewer_id = :other AS inserted FROM pr_reviews WHERE pull_request_id = :pr AND reviewer_id = :other;
\echo '--- C4. move that review onto the reviewer''s OWN pull request: must fail'
SELECT id AS ownpr FROM pull_requests WHERE author_id = :other ORDER BY id LIMIT 1 \gset
SAVEPOINT c4;
UPDATE pr_reviews SET pull_request_id = :ownpr WHERE pull_request_id = :pr AND reviewer_id = :other;
ROLLBACK TO c4;
\echo '--- C5. deleting that reviewer still works (FK SET NULL does not trip the trigger)'
DELETE FROM users WHERE id = :other;
SELECT count(*) AS reviews_with_null_reviewer FROM pr_reviews WHERE pull_request_id = :pr AND reviewer_id IS NULL;

ROLLBACK;
\echo '=== after ROLLBACK'
SELECT count(*) AS audit_rows FROM audit_log;
