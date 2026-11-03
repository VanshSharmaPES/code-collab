\pset pager off
\echo '=== 1. Dashboard totals must equal the raw table totals'
SELECT sum(open_issues + in_progress_issues + closed_issues) AS issues_in_view, (SELECT count(*) FROM issues) AS issues_raw,
       sum(open_prs + approved_prs + merged_prs + closed_prs) AS prs_in_view,    (SELECT count(*) FROM pull_requests) AS prs_raw,
       sum(total_commits) AS commits_in_view,                                      (SELECT count(*) FROM commits) AS commits_raw
FROM project_dashboard_v;

\echo '=== 2. Three projects from the dashboard'
SELECT project_id, project_name, mentor_name, members, open_issues, urgent_open_issues, merged_prs, total_commits, commits_last_7_days
FROM project_dashboard_v ORDER BY project_id LIMIT 3;

\echo '=== 3. Member view: per-project commit totals must equal the dashboard'
SELECT count(*) AS mismatched_projects
FROM (SELECT project_id, sum(commits) AS c FROM member_contribution_v GROUP BY project_id) a
JOIN project_dashboard_v d USING (project_id) WHERE d.total_commits <> a.c;

\echo '=== 4. Top 5 members by score, with the free riders at the bottom'
(SELECT project_name, full_name, commits, prs_merged, reviews_given, issues_closed, score FROM member_contribution_v ORDER BY score DESC LIMIT 5)
UNION ALL
(SELECT project_name, full_name, commits, prs_merged, reviews_given, issues_closed, score FROM member_contribution_v ORDER BY score ASC LIMIT 3);

\echo '=== 5. contribution_score() agrees with a hand-written calculation'
SELECT v.user_id AS u, v.project_id AS p, v.score AS view_score FROM member_contribution_v v ORDER BY score DESC LIMIT 1 \gset
SELECT contribution_score(:u, :p) AS function_score,
       (SELECT count(*) FROM commits c JOIN repositories r ON r.id = c.repository_id WHERE r.project_id = :p AND c.author_id = :u)
     + 5 * (SELECT count(*) FROM pull_requests x JOIN repositories r ON r.id = x.repository_id WHERE r.project_id = :p AND x.author_id = :u AND x.status = 'merged')
     + 3 * (SELECT count(*) FROM pr_reviews rv JOIN pull_requests x ON x.id = rv.pull_request_id JOIN repositories r ON r.id = x.repository_id WHERE r.project_id = :p AND rv.reviewer_id = :u)
     + 2 * (SELECT count(DISTINCT l.issue_id) FROM pr_issue_links l JOIN pull_requests x ON x.id = l.pull_request_id JOIN repositories r ON r.id = x.repository_id JOIN issues i ON i.id = l.issue_id WHERE r.project_id = :p AND x.author_id = :u AND x.status = 'merged' AND i.status = 'closed') AS hand_calculated,
       :view_score AS view_score;

\echo '=== 6. Edge cases: unknown user, unknown project, NULL'
SELECT contribution_score(999999, 1) AS unknown_user, contribution_score(1, 999999) AS unknown_project, contribution_score(NULL, NULL) AS nulls;

\echo '=== 7. Views are live: merge a PR and watch the dashboard change (rolled back afterwards)'
BEGIN;
SELECT p.id AS apr, t.lead_id AS mlead, r.project_id AS proj
FROM pull_requests p JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN projects pj ON pj.id = r.project_id AND pj.status = 'active'
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'approved' ORDER BY p.id LIMIT 1 \gset
SELECT merged_prs, approved_prs FROM project_dashboard_v WHERE project_id = :proj;
CALL merge_pull_request(:apr, :mlead);
SELECT merged_prs, approved_prs FROM project_dashboard_v WHERE project_id = :proj;
ROLLBACK;
