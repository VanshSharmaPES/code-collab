\set ON_ERROR_STOP off
\pset pager off
BEGIN;

-- Pick an approved PR in an active project that links to at least one open issue.
SELECT p.id AS pr, p.author_id AS author, t.lead_id AS merger, r.project_id AS proj
FROM pull_requests p
JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN projects pr ON pr.id = r.project_id AND pr.status = 'active'
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'approved'
  AND EXISTS (SELECT 1 FROM pr_issue_links l JOIN issues i ON i.id = l.issue_id
              WHERE l.pull_request_id = p.id AND i.status <> 'closed')
ORDER BY p.id LIMIT 1 \gset

\echo '=== BEFORE'
SELECT status, merged_by, merged_at FROM pull_requests WHERE id = :pr;
SELECT i.id, i.status FROM pr_issue_links l JOIN issues i ON i.id = l.issue_id WHERE l.pull_request_id = :pr;
SELECT (SELECT count(*) FROM audit_log) AS audit_rows,
       (SELECT count(*) FROM contribution_metrics WHERE user_id = :author AND project_id = :proj) AS metric_rows;

\echo '=== 1. FORCED FAILURE: must error, and everything must stay unchanged'
SAVEPOINT s1;
CALL merge_pull_request(:pr, :merger, TRUE);
ROLLBACK TO s1;
SELECT status FROM pull_requests WHERE id = :pr;
SELECT (SELECT count(*) FROM audit_log) AS audit_rows,
       (SELECT count(*) FROM issues i JOIN pr_issue_links l ON l.issue_id = i.id
         WHERE l.pull_request_id = :pr AND i.status = 'closed') AS closed_linked_issues;

\echo '=== 2. REAL MERGE'
CALL merge_pull_request(:pr, :merger);
SELECT status, merged_by = :merger AS merged_by_ok, merged_at IS NOT NULL AS has_merged_at FROM pull_requests WHERE id = :pr;
SELECT i.id, i.status, i.closed_at IS NOT NULL AS has_closed_at FROM pr_issue_links l JOIN issues i ON i.id = l.issue_id WHERE l.pull_request_id = :pr;
SELECT entity_type, action, old_status, new_status, details FROM audit_log ORDER BY id;
SELECT project_id, prs_merged, issues_closed FROM contribution_metrics WHERE user_id = :author AND project_id = :proj;

\echo '=== 3. MERGE AGAIN: must fail (already merged)'
SAVEPOINT s2;
CALL merge_pull_request(:pr, :merger);
ROLLBACK TO s2;

\echo '=== 4. OPEN PR WITHOUT APPROVAL: must fail'
SELECT id AS open_pr FROM pull_requests WHERE status = 'open' ORDER BY id LIMIT 1 \gset
SAVEPOINT s3;
CALL merge_pull_request(:open_pr, :merger);
ROLLBACK TO s3;

\echo '=== 5. WRONG USER (a student who is not a lead): must fail'
SELECT id AS stu FROM users WHERE role = 'student' ORDER BY id LIMIT 1 \gset
SELECT p.id AS pr2 FROM pull_requests p WHERE p.status = 'approved' AND p.id <> :pr ORDER BY id LIMIT 1 \gset
SAVEPOINT s4;
CALL merge_pull_request(:pr2, :stu);
ROLLBACK TO s4;

\echo '=== 6. NO SUCH PR: must fail'
SAVEPOINT s5;
CALL merge_pull_request(999999999, :merger);
ROLLBACK TO s5;

ROLLBACK;
\echo '=== after final ROLLBACK'
SELECT (SELECT count(*) FROM pull_requests WHERE status = 'merged') AS merged_prs, (SELECT count(*) FROM audit_log) AS audit_rows;
