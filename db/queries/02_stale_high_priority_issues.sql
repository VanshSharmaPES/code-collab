-- Q2: high and critical issues that are still unresolved and have not been touched for
-- more than 14 days. Most urgent and longest-neglected first.
-- Change the interval to tune what "stale" means.
SELECT p.id    AS project_id,
       p.name  AS project_name,
       i.id    AS issue_id,
       i.number,
       i.title,
       i.priority,
       i.status,
       u.full_name AS assignee,
       floor(extract(epoch FROM now() - i.updated_at) / 86400)::int AS days_since_update
FROM issues i
JOIN repositories r ON r.id = i.repository_id
JOIN projects p     ON p.id = r.project_id
LEFT JOIN users u   ON u.id = i.assignee_id
WHERE i.status IN ('open', 'in_progress')
  AND i.priority IN ('high', 'critical')
  AND i.updated_at < now() - interval '14 days'
ORDER BY (i.priority = 'critical') DESC, i.updated_at ASC, i.id;
