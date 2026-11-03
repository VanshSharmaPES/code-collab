-- P1-11: dashboard views. Both read live data, so they are always current.

-- One row per project. Each aggregate is computed in its own LATERAL subquery so that
-- joining issues, pull requests and commits cannot multiply rows into each other.
CREATE OR REPLACE VIEW project_dashboard_v AS
SELECT p.id           AS project_id,
       p.name         AS project_name,
       p.status       AS project_status,
       m.full_name    AS mentor_name,
       mem.members,
       iss.open_issues, iss.in_progress_issues, iss.closed_issues, iss.urgent_open_issues,
       prs.open_prs, prs.approved_prs, prs.merged_prs, prs.closed_prs,
       cm.total_commits, cm.commits_last_7_days, cm.last_commit_at
FROM projects p
LEFT JOIN users m ON m.id = p.mentor_id
LEFT JOIN LATERAL (
    SELECT count(DISTINCT tm.user_id) AS members
      FROM teams t JOIN team_members tm ON tm.team_id = t.id
     WHERE t.project_id = p.id) mem ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.status = 'open')        AS open_issues,
           count(*) FILTER (WHERE i.status = 'in_progress') AS in_progress_issues,
           count(*) FILTER (WHERE i.status = 'closed')      AS closed_issues,
           count(*) FILTER (WHERE i.status <> 'closed'
                              AND i.priority IN ('high', 'critical')) AS urgent_open_issues
      FROM issues i JOIN repositories r ON r.id = i.repository_id
     WHERE r.project_id = p.id) iss ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE x.status = 'open')     AS open_prs,
           count(*) FILTER (WHERE x.status = 'approved') AS approved_prs,
           count(*) FILTER (WHERE x.status = 'merged')   AS merged_prs,
           count(*) FILTER (WHERE x.status = 'closed')   AS closed_prs
      FROM pull_requests x JOIN repositories r ON r.id = x.repository_id
     WHERE r.project_id = p.id) prs ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*)                                                    AS total_commits,
           count(*) FILTER (WHERE c.committed_at > now() - interval '7 days') AS commits_last_7_days,
           max(c.committed_at)                                         AS last_commit_at
      FROM commits c JOIN repositories r ON r.id = c.repository_id
     WHERE r.project_id = p.id) cm ON TRUE;

-- One row per member per project, with the score. A person on two teams of the same
-- project still appears once.
CREATE OR REPLACE VIEW member_contribution_v AS
SELECT p.id        AS project_id,
       p.name      AS project_name,
       u.id        AS user_id,
       u.full_name,
       u.role      AS user_role,
       c.commits, c.prs_opened, c.prs_merged, c.reviews_given, c.issues_closed,
       score_from_counts(c.commits, c.prs_merged, c.reviews_given, c.issues_closed) AS score
FROM (SELECT DISTINCT t.project_id, tm.user_id
        FROM teams t JOIN team_members tm ON tm.team_id = t.id) m
JOIN projects p ON p.id = m.project_id
JOIN users u    ON u.id = m.user_id
-- OFFSET 0 is a planner fence (P1-14). Without it Postgres inlines contribution_counts
-- and re-runs its subqueries for every reference to a count or to score, which made a
-- query using score nine times take about 8 s on 1M commits instead of about 1.3 s.
CROSS JOIN LATERAL (SELECT * FROM contribution_counts(u.id, p.id) OFFSET 0) c;
