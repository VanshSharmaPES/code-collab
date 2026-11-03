-- Q3: team members who have never reviewed a pull request in their project, together
-- with how active they are otherwise. An anti-join: LEFT JOIN to the reviewers, then keep
-- only the rows where no match was found.
SELECT p.id   AS project_id,
       p.name AS project_name,
       u.id   AS user_id,
       u.full_name,
       u.role AS user_role,
       c.commits,
       c.prs_opened
FROM (SELECT DISTINCT t.project_id, tm.user_id
        FROM teams t JOIN team_members tm ON tm.team_id = t.id) m
JOIN projects p ON p.id = m.project_id
JOIN users u    ON u.id = m.user_id
LEFT JOIN (
    SELECT DISTINCT r.project_id, rv.reviewer_id
      FROM pr_reviews rv
      JOIN pull_requests x ON x.id = rv.pull_request_id
      JOIN repositories r  ON r.id = x.repository_id
) reviewed ON reviewed.project_id = m.project_id AND reviewed.reviewer_id = m.user_id
CROSS JOIN LATERAL contribution_counts(u.id, p.id) c
WHERE reviewed.reviewer_id IS NULL
ORDER BY c.commits DESC, p.id, u.id;
