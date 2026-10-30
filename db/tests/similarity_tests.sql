-- P1-18: tests for similar_issues() and recommend_reviewers(). Every test asserts; any failure stops the run.
-- Runs inside one transaction that is rolled back, so the database is left unchanged.
-- Needs schema files 01-06, 08_embeddings.sql (P1-17) and 11_similarity.sql. It builds its own small project with
-- hand-made vectors, so the expected answers are known in advance; the seed is not needed.
--   podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/tests/similarity_tests.sql
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

CREATE FUNCTION pg_temp.expect_true(p_name text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
    EXECUTE 'SELECT (' || p_sql || ')' INTO ok;
    IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %: % is not true', p_name, p_sql; END IF;
    RAISE NOTICE 'pass  %', p_name;
END;
$$;

-- A 384-number vector whose first three numbers are x, y and z and the rest 0.
CREATE FUNCTION pg_temp.vec(x float8, y float8, z float8) RETURNS vector
LANGUAGE sql AS $$ SELECT (ARRAY[x, y, z] || array_fill(0::float8, ARRAY[381]))::vector $$;

-- Fixtures. Project P: mentor m, lead l, members a, b, c. Project Q: member o.
CREATE TEMP TABLE u AS
WITH ins AS (
    INSERT INTO users (email, full_name, password_hash, role) VALUES
        ('sim-m@t.test', 'Sim M', 'x', 'mentor'), ('sim-l@t.test', 'Sim L', 'x', 'lead'),
        ('sim-a@t.test', 'Sim A', 'x', 'student'), ('sim-b@t.test', 'Sim B', 'x', 'student'),
        ('sim-c@t.test', 'Sim C', 'x', 'student'), ('sim-o@t.test', 'Sim O', 'x', 'student')
    RETURNING id, split_part(split_part(email, '@', 1), '-', 2) AS k)
SELECT k, id FROM ins;
CREATE FUNCTION pg_temp.u(p_k text) RETURNS bigint LANGUAGE sql AS $$ SELECT id FROM u WHERE k = p_k $$;

CREATE TEMP TABLE pj AS
WITH ins AS (INSERT INTO projects (name, mentor_id) VALUES ('Sim P', pg_temp.u('m')), ('Sim Q', pg_temp.u('m')) RETURNING id, name)
SELECT right(name, 1) AS k, id FROM ins;
INSERT INTO teams (project_id, name, lead_id) SELECT id, 'team', CASE k WHEN 'P' THEN pg_temp.u('l') END FROM pj;
INSERT INTO team_members (team_id, user_id)
SELECT t.id, pg_temp.u(x) FROM teams t JOIN pj ON pj.id = t.project_id AND pj.k = 'P', unnest(ARRAY['l', 'a', 'b', 'c']) x
UNION ALL
SELECT t.id, pg_temp.u('o') FROM teams t JOIN pj ON pj.id = t.project_id AND pj.k = 'Q';
CREATE TEMP TABLE rp AS
WITH ins AS (INSERT INTO repositories (project_id, name) SELECT id, 'sim-repo-' || k FROM pj RETURNING id, right(name, 1) AS k)
SELECT k, id FROM ins;

-- Issues. i1 is the one we look up. i2 is nearly the same, i3 half related, i4 unrelated, i5 has no embedding,
-- i6 is identical but in project Q, i7 is identical but embedded with another model.
CREATE TEMP TABLE iss (k text, id bigint);
WITH ins AS (
    INSERT INTO issues (repository_id, number, title)
    SELECT (SELECT id FROM rp WHERE k = CASE WHEN n = 6 THEN 'Q' ELSE 'P' END), 900000 + n, 'sim issue ' || n
      FROM generate_series(1, 7) n
    RETURNING id, 'i' || (number - 900000) AS k)
INSERT INTO iss SELECT k, id FROM ins;
INSERT INTO embeddings (entity_type, entity_id, model, content_hash, embedding)
SELECT 'issue', iss.id, CASE WHEN iss.k = 'i7' THEN 'other-model' ELSE 'test-model' END, 'h', v.e
  FROM iss JOIN (VALUES ('i1', pg_temp.vec(1, 0, 0)), ('i2', pg_temp.vec(0.98, 0.2, 0)), ('i3', pg_temp.vec(0.6, 0.8, 0)),
                        ('i4', pg_temp.vec(0, 0, 1)), ('i6', pg_temp.vec(1, 0, 0)), ('i7', pg_temp.vec(1, 0, 0))) v(k, e) USING (k);
CREATE FUNCTION pg_temp.i(p_k text) RETURNS bigint LANGUAGE sql AS $$ SELECT id FROM iss WHERE k = p_k $$;

\echo '--- similar_issues'
SELECT pg_temp.expect_true('default threshold finds only the near-identical issue',
  format($q$ARRAY(SELECT issue_id FROM similar_issues(%s, 'test-model')) = ARRAY[%s]::bigint[]$q$, pg_temp.i('i1'), pg_temp.i('i2')));
SELECT pg_temp.expect_true('a lower threshold adds the half-related issue, most similar first',
  format($q$ARRAY(SELECT issue_id FROM similar_issues(%s, 'test-model', 5, 0.5)) = ARRAY[%s, %s]::bigint[]$q$, pg_temp.i('i1'), pg_temp.i('i2'), pg_temp.i('i3')));
SELECT pg_temp.expect_true('the issue itself, other projects and other models are never returned',
  format($q$NOT EXISTS (SELECT 1 FROM similar_issues(%s, 'test-model', 50, -1) WHERE issue_id IN (%s, %s, %s))$q$,
         pg_temp.i('i1'), pg_temp.i('i1'), pg_temp.i('i6'), pg_temp.i('i7')));
SELECT pg_temp.expect_true('the similarity is cosine similarity, rounded',
  format($q$(SELECT similarity FROM similar_issues(%s, 'test-model')) = round((0.98 / sqrt(0.98 * 0.98 + 0.04))::numeric, 3)$q$, pg_temp.i('i1')));
SELECT pg_temp.expect_true('the limit is respected',
  format($q$(SELECT count(*) FROM similar_issues(%s, 'test-model', 1, -1)) = 1$q$, pg_temp.i('i1')));
SELECT pg_temp.expect_true('an issue without an embedding gives no rows',
  format($q$NOT EXISTS (SELECT 1 FROM similar_issues(%s, 'test-model', 5, -1))$q$, pg_temp.i('i5')));

-- Pull requests in project P. t is the one needing reviewers, written by a and already reviewed by l.
--   n1: nearly the same as t, written by b, reviewed by c.
--   n2: unrelated to t, written by l, reviewed by b.
--   n3: fairly close to t, written by c, reviewed by a (t's author) and by o (not on the project).
CREATE TEMP TABLE prs (k text, id bigint);
WITH ins AS (
    INSERT INTO pull_requests (repository_id, number, title, author_id)
    SELECT (SELECT id FROM rp WHERE k = 'P'), 900000 + n, 'sim pr ' || n, pg_temp.u(a)
      FROM (VALUES (0, 'a'), (1, 'b'), (2, 'l'), (3, 'c')) v(n, a)
    RETURNING id, CASE number - 900000 WHEN 0 THEN 't' ELSE 'n' || (number - 900000) END AS k)
INSERT INTO prs SELECT k, id FROM ins;
CREATE FUNCTION pg_temp.p(p_k text) RETURNS bigint LANGUAGE sql AS $$ SELECT id FROM prs WHERE k = p_k $$;
INSERT INTO embeddings (entity_type, entity_id, model, content_hash, embedding)
SELECT 'pull_request', prs.id, 'test-model', 'h', v.e
  FROM prs JOIN (VALUES ('t', pg_temp.vec(1, 0, 0)), ('n1', pg_temp.vec(1, 0.1, 0)), ('n2', pg_temp.vec(0, 1, 0)), ('n3', pg_temp.vec(0.9, 0.4, 0))) v(k, e) USING (k);
INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) VALUES
    (pg_temp.p('t'),  pg_temp.u('l'), 'commented'),
    (pg_temp.p('n1'), pg_temp.u('c'), 'approved'),
    (pg_temp.p('n2'), pg_temp.u('b'), 'approved'),
    (pg_temp.p('n3'), pg_temp.u('a'), 'approved'),
    (pg_temp.p('n3'), pg_temp.u('o'), 'commented');

\echo '--- recommend_reviewers'
SELECT pg_temp.expect_true('c (reviewed n1, wrote n3) comes first, then b (wrote n1)',
  format($q$ARRAY(SELECT user_id FROM recommend_reviewers(%s, 'test-model')) = ARRAY[%s, %s]::bigint[]$q$, pg_temp.p('t'), pg_temp.u('c'), pg_temp.u('b')));
SELECT pg_temp.expect_true('a review counts fully and authorship half',
  format($q$(SELECT score FROM recommend_reviewers(%s, 'test-model') WHERE user_id = %s)
            = round((1 / sqrt(1.01) + 0.5 * 0.9 / sqrt(0.97))::numeric, 3)$q$, pg_temp.p('t'), pg_temp.u('c')));
SELECT pg_temp.expect_true('evidence counts the similar pull requests behind the score',
  format($q$(SELECT evidence FROM recommend_reviewers(%s, 'test-model') WHERE user_id = %s) = 2$q$, pg_temp.p('t'), pg_temp.u('c')));
SELECT pg_temp.expect_true('the author, an existing reviewer and an outsider are never suggested',
  format($q$NOT EXISTS (SELECT 1 FROM recommend_reviewers(%s, 'test-model', 50) WHERE user_id IN (%s, %s, %s))$q$,
         pg_temp.p('t'), pg_temp.u('a'), pg_temp.u('l'), pg_temp.u('o')));
SELECT pg_temp.expect_true('only the closest neighbours count: with one neighbour, n3 drops out of c''s score',
  format($q$(SELECT score FROM recommend_reviewers(%s, 'test-model', 3, 1) WHERE user_id = %s) = round((1 / sqrt(1.01))::numeric, 3)$q$, pg_temp.p('t'), pg_temp.u('c')));
SELECT pg_temp.expect_true('a pull request without an embedding gets no suggestions',
  format($q$NOT EXISTS (SELECT 1 FROM recommend_reviewers(%s, 'other-model'))$q$, pg_temp.p('t')));

\echo '=== ALL SIMILARITY TESTS PASSED'
ROLLBACK;
