-- P1-14: scale the synthetic dataset up so that index choices make a measurable
-- difference. Run it ONLY in the separate codecollab_perf database, never in the
-- development database. Needs the schema and dev_synthetic.sql loaded first.
--
-- Adds, on top of the seed: 1,000,000 commits, 150,000 issues, 80,000 pull requests,
-- reviews and PR-issue links. Takes one to three minutes.
-- Change the three numbers below to scale up or down.

\set ON_ERROR_STOP on
\set commits 1000000
\set issues  150000
\set prs     80000

BEGIN;
SELECT setseed(0.7);

-- Each synthetic repository with its team members, and the members who already review
-- there. Reusing the reviewers keeps the seed's free riders as non-reviewers.
CREATE TEMP TABLE s_repo AS
SELECT r.id AS repo_id,
       row_number() OVER (ORDER BY r.id)::int AS n,
       array_agg(DISTINCT tm.user_id) AS members
FROM repositories r
JOIN teams t         ON t.project_id = r.project_id
JOIN team_members tm ON tm.team_id = t.id
WHERE r.is_synthetic
GROUP BY r.id;

CREATE TEMP TABLE s_reviewers AS
SELECT x.repository_id AS repo_id, array_agg(DISTINCT rv.reviewer_id) AS reviewers
FROM pr_reviews rv JOIN pull_requests x ON x.id = rv.pull_request_id
WHERE rv.reviewer_id IS NOT NULL
GROUP BY x.repository_id;

SELECT count(*) AS nrepos FROM s_repo \gset

-- Commits. Row g goes to repository 1 + (g mod nrepos); the SHA is unique per g.
INSERT INTO commits (repository_id, sha, author_id, message, additions, deletions,
                     files_changed, committed_at)
SELECT r.repo_id,
       md5('scale-c' || g) || substr(md5('scale-d' || g), 1, 8),
       r.members[1 + floor(random() * cardinality(r.members))::int],
       'Scaled commit ' || g,
       floor(random() * 200)::int,
       floor(random() * 80)::int,
       1 + floor(random() * 10)::int,
       now() - random() * interval '120 days'
FROM generate_series(1, :commits) g
JOIN s_repo r ON r.n = 1 + (g % :nrepos);

-- Issues. Numbers start at 100001 so they never clash with the seed's numbering.
INSERT INTO issues (repository_id, number, title, status, priority, author_id,
                    assignee_id, created_at, updated_at, closed_at)
SELECT r.repo_id,
       100000 + x.g,
       'Scaled issue ' || x.g,
       x.status,
       x.priority,
       r.members[1 + floor(random() * cardinality(r.members))::int],
       CASE WHEN random() < 0.6 THEN r.members[1 + floor(random() * cardinality(r.members))::int] END,
       x.created_at,
       CASE WHEN x.status = 'closed' THEN x.created_at + x.lag
            WHEN random() < 0.35     THEN x.created_at
            ELSE x.created_at + random() * (now() - x.created_at) END,
       CASE WHEN x.status = 'closed' THEN x.created_at + x.lag END
FROM (
    SELECT g, t.created_at, random() * (now() - t.created_at) AS lag,
           CASE WHEN t.rs < 0.50 THEN 'closed' WHEN t.rs < 0.80 THEN 'open' ELSE 'in_progress' END AS status,
           CASE WHEN t.rp < 0.25 THEN 'low' WHEN t.rp < 0.70 THEN 'medium'
                WHEN t.rp < 0.92 THEN 'high' ELSE 'critical' END AS priority
    FROM generate_series(1, :issues) g
    CROSS JOIN LATERAL (SELECT now() - interval '1 day' - random() * interval '120 days' AS created_at,
                               random() AS rs, random() AS rp) t
) x
JOIN s_repo r ON r.n = 1 + (x.g % :nrepos);

-- Pull requests.
INSERT INTO pull_requests (repository_id, number, title, status, author_id, merged_by,
                           created_at, updated_at, merged_at)
SELECT r.repo_id,
       100000 + x.g,
       'Scaled pull request ' || x.g,
       x.status,
       r.members[1 + floor(random() * cardinality(r.members))::int],
       CASE WHEN x.status = 'merged' THEN r.members[1 + floor(random() * cardinality(r.members))::int] END,
       x.created_at,
       x.created_at + x.lag,
       CASE WHEN x.status = 'merged' THEN x.created_at + x.lag END
FROM (
    SELECT g, t.created_at, random() * (now() - t.created_at) AS lag,
           CASE WHEN t.rs < 0.55 THEN 'merged' WHEN t.rs < 0.67 THEN 'closed'
                WHEN t.rs < 0.85 THEN 'open' ELSE 'approved' END AS status
    FROM generate_series(1, :prs) g
    CROSS JOIN LATERAL (SELECT now() - interval '1 day' - random() * interval '120 days' AS created_at,
                               random() AS rs) t
) x
JOIN s_repo r ON r.n = 1 + (x.g % :nrepos);

-- One review on each scaled merged or approved PR, and on about half of the rest.
-- The reviewer is never the author, so the self-review trigger is respected.
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict, submitted_at)
SELECT y.pr_id, y.reviewer,
       CASE WHEN y.status IN ('merged', 'approved') THEN 'approved'
            WHEN random() < 0.6 THEN 'commented' ELSE 'changes_requested' END,
       y.created_at + random() * (y.updated_at - y.created_at)
FROM (
    SELECT p.id AS pr_id, p.status, p.created_at, p.updated_at, p.author_id,
           CASE WHEN rv.reviewers[k.i] = p.author_id
                THEN rv.reviewers[1 + (k.i % cardinality(rv.reviewers))]
                ELSE rv.reviewers[k.i] END AS reviewer
    FROM pull_requests p
    JOIN s_reviewers rv ON rv.repo_id = p.repository_id
    CROSS JOIN LATERAL (SELECT 1 + floor(random() * cardinality(rv.reviewers))::int AS i) k
    WHERE p.number > 100000
      AND cardinality(rv.reviewers) >= 2
      AND (p.status IN ('merged', 'approved') OR random() < 0.5)
) y
WHERE y.reviewer IS DISTINCT FROM y.author_id;

-- Links: about 40% of scaled PRs close one scaled issue from the same repository.
-- Issue g and PR g share a repository when g mod nrepos matches, which is what the
-- arithmetic below guarantees.
INSERT INTO pr_issue_links (pull_request_id, issue_id)
SELECT DISTINCT p.id, i.id
FROM pull_requests p
CROSS JOIN LATERAL (
    SELECT ((p.number - 100000) % :nrepos) + :nrepos * floor(random() * (:issues / :nrepos))::int AS gi
) k
JOIN issues i ON i.repository_id = p.repository_id AND i.number = 100000 + k.gi
WHERE p.number > 100000 AND random() < 0.4;

COMMIT;

-- Refresh planner statistics and the visibility map, so plans and index-only scans
-- reflect the new data.
VACUUM ANALYZE;

SELECT (SELECT count(*) FROM commits) AS commits, (SELECT count(*) FROM issues) AS issues,
       (SELECT count(*) FROM pull_requests) AS prs, (SELECT count(*) FROM pr_reviews) AS reviews,
       (SELECT count(*) FROM pr_issue_links) AS links;
