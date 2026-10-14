-- Synthetic dataset (P1-06): 60 users, 15 projects, 4,000 issues, 2,000 pull
-- requests, 15,000 commits, plus teams, labels, reviews and PR-issue links.
--
-- Rules this file follows:
--   * Everything it creates is tagged so it can be found and removed again:
--     users have @seed.codecollab.test emails, projects are created_by a seed
--     mentor, repositories have is_synthetic = TRUE.
--   * It never writes explicit ids, so it cannot collide with real ingested rows.
--   * Rerunnable: the first two statements remove a previous seed.
--   * Deterministic shape: setseed() fixes the random sequence. Timestamps are
--     relative to now(), so they move with the run date but keep the same shape.
--
-- Run: podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/seed/dev_synthetic.sql

BEGIN;
SELECT setseed(0.42);

-- 0. Remove any previous synthetic data (CASCADE removes everything below projects).
DELETE FROM projects WHERE created_by IN (SELECT id FROM users WHERE email LIKE '%@seed.codecollab.test');
DELETE FROM users WHERE email LIKE '%@seed.codecollab.test';

-- Time window: 85 days ending yesterday.
CREATE TEMP TABLE s_params AS
SELECT now() - interval '85 days' AS t0, now() - interval '1 day' AS t1;

-- Random timestamp in [lo, hi] with clustering: 45% of events fall in bursts in the
-- days before one of three "deadlines", weekend events are pushed to weekdays 60% of
-- the time, and most activity happens in the evening.
CREATE FUNCTION pg_temp.seed_ts(lo timestamptz, hi timestamptz) RETURNS timestamptz AS $$
DECLARE
    span interval := hi - lo;
    base timestamptz;
    hr   int;
BEGIN
    IF random() < 0.45 THEN
        base := lo + span * (ARRAY[0.33, 0.66, 0.97])[1 + floor(random() * 3)::int]
                   - power(random(), 2) * interval '6 days';
    ELSE
        base := lo + random() * span;
    END IF;
    IF extract(isodow FROM base) >= 6 AND random() < 0.6 THEN
        base := base - interval '2 days';
    END IF;
    IF random() < 0.7 THEN hr := 15 + floor(random() * 9)::int;
    ELSE hr := floor(random() * 15)::int;
    END IF;
    base := date_trunc('day', base) + hr * interval '1 hour' + random() * interval '59 minutes';
    RETURN least(greatest(base, lo), hi);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 1. Users: 3 mentors, 15 leads, 42 students. Everyone's password is "password123".
INSERT INTO users (email, full_name, password_hash, role, github_username, created_at)
SELECT 'user' || lpad(i::text, 2, '0') || '@seed.codecollab.test',
       (ARRAY['Aarav','Diya','Kabir','Meera','Rohan','Isha','Arjun','Ananya','Vihaan','Saanvi',
              'Aditya','Kavya','Reyansh','Nisha','Dev','Tara','Ishaan','Riya','Neel','Pooja'])[1 + (i - 1) % 20]
       || ' ' ||
       (ARRAY['Sharma','Iyer','Nair','Rao','Gupta','Menon','Patel','Reddy','Das','Kulkarni'])[1 + ((i - 1) / 20 * 3 + (i - 1)) % 10],
       '$argon2id$v=19$m=65536,t=3,p=4$FbL9/Zeh3jvyA+eHqnmw2g$rPpuVlR8y3fOftU0uWQipbSoZJdY3QfEqgYWEZ/qur8',
       CASE WHEN i <= 3 THEN 'mentor' WHEN i <= 18 THEN 'lead' ELSE 'student' END,
       'seed-user-' || lpad(i::text, 2, '0'),
       (SELECT t0 FROM s_params) - interval '5 days'
FROM generate_series(1, 60) AS i
ORDER BY i;

CREATE TEMP TABLE s_user AS
SELECT id, substr(email, 5, 2)::int AS n, role
FROM users WHERE email LIKE '%@seed.codecollab.test';

-- 2. Projects: 15, mentors assigned round-robin.
INSERT INTO projects (name, description, status, mentor_id, created_by, created_at)
SELECT p.name,
       'Synthetic project: ' || p.name,
       CASE WHEN p.n = 15 THEN 'archived' ELSE 'active' END,
       m.id, m.id,
       (SELECT t0 FROM s_params) - interval '3 days'
FROM (SELECT n, name FROM unnest(ARRAY[
        'Library Portal','Campus Events','Hostel Manager','Alumni Network','Lab Booking',
        'Course Planner','Placement Tracker','Canteen Orders','Study Groups','Research Hub',
        'Sports Scheduler','Club Directory','Notes Exchange','Grievance Desk','Travel Pool'
      ]) WITH ORDINALITY AS t(name, n)) p
JOIN s_user m ON m.role = 'mentor' AND m.n = 1 + (p.n - 1) % 3
ORDER BY p.n;

CREATE TEMP TABLE s_project AS
SELECT id, row_number() OVER (ORDER BY id)::int AS n, mentor_id
FROM projects WHERE created_by IN (SELECT id FROM s_user);

-- 3. Teams: one per project, led by lead number (project n). Students go round-robin.
INSERT INTO teams (project_id, name, lead_id, created_at)
SELECT p.id, 'Team ' || lpad(p.n::text, 2, '0'), l.id, (SELECT t0 FROM s_params)
FROM s_project p
JOIN s_user l ON l.role = 'lead' AND l.n = 3 + p.n
ORDER BY p.n;

CREATE TEMP TABLE s_team AS
SELECT t.id, t.project_id, t.lead_id, p.n
FROM teams t JOIN s_project p ON p.id = t.project_id;

INSERT INTO team_members (team_id, user_id, joined_at)
SELECT t.id, t.lead_id, (SELECT t0 FROM s_params) FROM s_team t
UNION ALL
SELECT t.id, s.id, (SELECT t0 FROM s_params) + interval '1 day'
FROM s_user s
JOIN s_team t ON t.n = 1 + (s.n - 19) % 15
WHERE s.role = 'student';

-- 4. One synthetic repository per project.
INSERT INTO repositories (project_id, name, github_url, default_branch, is_synthetic, created_at)
SELECT p.id, 'repo-' || lpad(p.n::text, 2, '0'), NULL, 'main', TRUE, (SELECT t0 FROM s_params)
FROM s_project p ORDER BY p.n;

CREATE TEMP TABLE s_repo AS
SELECT r.id, r.project_id, p.n
FROM repositories r JOIN s_project p ON p.id = r.project_id
WHERE r.is_synthetic;

-- Per-member behaviour. Within each team the members are ordered by a stable hash:
--   rank 1 is the dominant contributor, rank 2 is a free rider (few commits, never
--   reviews), everyone else is average. This is what makes the analytics interesting.
CREATE TEMP TABLE s_member AS
SELECT r.id AS repo_id, r.project_id, tm.user_id, u.full_name, u.email,
       rk AS rank,
       CASE rk WHEN 1 THEN 6.0 WHEN 2 THEN 0.4 ELSE 2.0 END AS commit_w,
       (rk <> 2) AS does_review
FROM s_repo r
JOIN s_team t ON t.project_id = r.project_id
JOIN (SELECT team_id, user_id,
             row_number() OVER (PARTITION BY team_id ORDER BY md5(user_id::text))::int AS rk
      FROM team_members) tm ON tm.team_id = t.id
JOIN users u ON u.id = tm.user_id;

-- 5. Labels: the same six per project.
INSERT INTO labels (project_id, name, color)
SELECT p.id, l.name, l.color
FROM s_project p
CROSS JOIN (VALUES ('bug','#d73a4a'),('feature','#0e8a16'),('docs','#0075ca'),
                   ('refactor','#cfd3d7'),('test','#fbca04'),('question','#d876e3')) AS l(name, color);

-- 6. Issues: 4,000. Repos are chosen with a mild skew so some projects are busier.
CREATE TEMP TABLE s_issue_gen AS
SELECT g AS gs,
       1 + floor(15 * power(random(), 1.3))::int AS rn,
       pg_temp.seed_ts((SELECT t0 FROM s_params), (SELECT t1 FROM s_params) - interval '1 day') AS created_at,
       random() AS r_status, random() AS r_prio, random() AS r_touch, random() AS r_close
FROM generate_series(1, 4000) g;

INSERT INTO issues (repository_id, number, title, body, status, priority, author_id,
                    assignee_id, created_at, updated_at, closed_at)
SELECT x.repo_id,
       row_number() OVER (PARTITION BY x.repo_id ORDER BY x.created_at, x.gs),
       (ARRAY['Fix','Improve','Add','Investigate','Refactor','Document','Test'])[1 + (x.gs % 7)]
         || ' ' || (ARRAY['login flow','search page','dashboard','API errors','pagination',
                          'build script','form validation','notifications'])[1 + (x.gs % 8)]
         || ' (#' || x.gs || ')',
       'Synthetic issue body ' || x.gs,
       x.status, x.priority, au.user_id, asg.user_id,
       x.created_at,
       CASE WHEN x.status = 'closed' THEN x.closed_at
            WHEN x.r_touch < 0.35 THEN x.created_at
            ELSE x.created_at + x.r_touch * ((SELECT t1 FROM s_params) - x.created_at) END,
       CASE WHEN x.status = 'closed' THEN x.closed_at END
FROM (
    SELECT g.*, r.id AS repo_id,
           CASE WHEN g.r_status < 0.50 THEN 'closed'
                WHEN g.r_status < 0.80 THEN 'open' ELSE 'in_progress' END AS status,
           CASE WHEN g.r_prio < 0.25 THEN 'low' WHEN g.r_prio < 0.70 THEN 'medium'
                WHEN g.r_prio < 0.92 THEN 'high' ELSE 'critical' END AS priority,
           g.created_at + power(g.r_close, 2) * least(interval '30 days',
                ((SELECT t1 FROM s_params) - g.created_at)) AS closed_at
    FROM s_issue_gen g JOIN s_repo r ON r.n = g.rn
) x
LEFT JOIN LATERAL (SELECT m.user_id FROM s_member m WHERE m.repo_id = x.repo_id
                   ORDER BY power(random(), 1.0 / m.commit_w) DESC LIMIT 1) au ON TRUE
LEFT JOIN LATERAL (SELECT m.user_id FROM s_member m WHERE m.repo_id = x.repo_id
                   ORDER BY random() LIMIT 1) asg ON x.status <> 'open' OR x.gs % 3 = 0;

-- 7. Issue labels: one or two per issue.
INSERT INTO issue_labels (issue_id, label_id)
SELECT DISTINCT i.id, l.id
FROM issues i
JOIN s_repo r ON r.id = i.repository_id
JOIN labels l ON l.project_id = r.project_id
WHERE (hashtext(i.id::text || l.name) & 7) < 2;

-- 8. Pull requests: 2,000.
CREATE TEMP TABLE s_pr_gen AS
SELECT g AS gs,
       1 + floor(15 * power(random(), 1.3))::int AS rn,
       pg_temp.seed_ts((SELECT t0 FROM s_params), (SELECT t1 FROM s_params) - interval '6 days') AS created_at,
       random() AS r_status, random() AS r_dur
FROM generate_series(1, 2000) g;

INSERT INTO pull_requests (repository_id, number, title, description, status, author_id,
                           merged_by, created_at, updated_at, merged_at)
SELECT x.repo_id,
       row_number() OVER (PARTITION BY x.repo_id ORDER BY x.created_at, x.gs),
       (ARRAY['Implement','Refactor','Fix','Update','Remove'])[1 + (x.gs % 5)]
         || ' ' || (ARRAY['auth module','schema','UI components','tests','CI config',
                          'API client','reports'])[1 + (x.gs % 7)] || ' (PR ' || x.gs || ')',
       'Synthetic pull request ' || x.gs,
       x.status, au.user_id,
       CASE WHEN x.status = 'merged' THEN mg.user_id END,
       x.created_at,
       x.created_at + x.r_dur * x.dur,
       CASE WHEN x.status = 'merged' THEN x.created_at + x.r_dur * x.dur END
FROM (
    SELECT g.*, r.id AS repo_id,
           CASE WHEN g.r_status < 0.55 THEN 'merged' WHEN g.r_status < 0.67 THEN 'closed'
                WHEN g.r_status < 0.85 THEN 'open' ELSE 'approved' END AS status,
           least(interval '5 days', (SELECT t1 FROM s_params) - g.created_at) AS dur
    FROM s_pr_gen g JOIN s_repo r ON r.n = g.rn
) x
LEFT JOIN LATERAL (SELECT m.user_id FROM s_member m WHERE m.repo_id = x.repo_id
                   ORDER BY power(random(), 1.0 / m.commit_w) DESC LIMIT 1) au ON TRUE
LEFT JOIN LATERAL (SELECT m.user_id FROM s_member m
                   WHERE m.repo_id = x.repo_id AND m.does_review AND m.user_id <> au.user_id
                   ORDER BY random() LIMIT 1) mg ON TRUE;

-- 9. Reviews: reviewer is never the PR author and never a free rider.
--    Merged and approved PRs get 1-2 approvals; the rest get 0-2 comments or change requests.
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict, body, submitted_at)
SELECT p.id, rv.user_id,
       CASE WHEN p.status IN ('merged', 'approved') THEN 'approved'
            WHEN random() < 0.6 THEN 'commented' ELSE 'changes_requested' END,
       'Synthetic review',
       p.created_at + random() * (p.updated_at - p.created_at)
FROM pull_requests p
JOIN s_repo r ON r.id = p.repository_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.status IN ('merged', 'approved') THEN 1 + floor(random() * 2)::int
                ELSE floor(random() * 3)::int END AS k
) cnt
JOIN LATERAL (SELECT m.user_id FROM s_member m
              WHERE m.repo_id = p.repository_id AND m.does_review
                AND m.user_id IS DISTINCT FROM p.author_id
              ORDER BY random() LIMIT cnt.k) rv ON TRUE;

-- 10. PR-issue links: about 40% of PRs. An open or approved PR links to a not-yet-closed
--     issue; a merged or closed PR links to a closed issue.
INSERT INTO pr_issue_links (pull_request_id, issue_id)
SELECT p.id, i.id
FROM pull_requests p
JOIN s_repo r ON r.id = p.repository_id
JOIN LATERAL (SELECT iss.id FROM issues iss
              WHERE iss.repository_id = p.repository_id
                AND (p.status IN ('open', 'approved')) = (iss.status <> 'closed')
              ORDER BY random() LIMIT 1) i ON TRUE
WHERE (hashtext(p.id::text) & 255) < 102;

-- 11. Commits: 15,000. Authors weighted by member behaviour, bursty timestamps.
INSERT INTO commits (repository_id, sha, author_id, author_name, author_email, message,
                     additions, deletions, files_changed, committed_at)
SELECT x.repo_id,
       substr(md5('c' || x.gs) || md5('d' || x.gs), 1, 40),
       au.user_id, au.full_name, au.email,
       (ARRAY['Add','Fix','Update','Refactor','Remove','Tweak'])[1 + (x.gs % 6)]
         || ' ' || (ARRAY['handler','query','layout','config','tests','docs','schema'])[1 + (x.gs % 7)]
         || ' (' || x.gs || ')',
       floor(power(random(), 3) * 400)::int,
       floor(power(random(), 3) * 150)::int,
       1 + floor(power(random(), 2) * 12)::int,
       x.committed_at
FROM (
    SELECT g AS gs, r.id AS repo_id,
           pg_temp.seed_ts((SELECT t0 FROM s_params), (SELECT t1 FROM s_params)) AS committed_at
    FROM (SELECT g, 1 + floor(15 * power(random(), 1.3))::int AS rn
          FROM generate_series(1, 15000) g) c
    JOIN s_repo r ON r.n = c.rn
) x
JOIN LATERAL (SELECT m.user_id, m.full_name, m.email FROM s_member m WHERE m.repo_id = x.repo_id
              ORDER BY power(random(), 1.0 / m.commit_w) DESC LIMIT 1) au ON TRUE;

COMMIT;
