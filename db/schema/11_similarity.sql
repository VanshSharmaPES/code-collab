-- P1-18: similarity queries over the embeddings table.
-- Needs 08_embeddings.sql (P1-17: pgvector, the embeddings table and its HNSW index) and vectors written by the
-- embedding pipeline (P2-17). Pass the same model name the pipeline used: vectors from different models are never compared.
--
--   SELECT * FROM similar_issues(42, 'Xenova/all-MiniLM-L6-v2');           -- possible duplicates of issue 42
--   SELECT * FROM recommend_reviewers(17, 'Xenova/all-MiniLM-L6-v2');      -- who should review pull request 17
--
-- Both search only inside the project of the given row, and compare every candidate exactly (no HNSW index).
-- A project holds a few thousand rows at most, so this takes milliseconds. The HNSW index returns the nearest rows of
-- ALL projects and types first and filters afterwards, so a project-scoped query through it can silently return fewer
-- rows than asked for. The index stays for the global semantic search (P2-18).
--
-- Neither function checks who is asking. The caller must first check that the viewer takes part in the project
-- (participantSql in src/lib/project-access.ts), as for every other query.
--
-- Similarity is cosine similarity, 1 - (a <=> b): 1 means the same direction, 0 unrelated.

-- Possible duplicates of an issue: the most similar other issues of the same project, open or closed (a duplicate of
-- a closed issue is just as useful to know). Nothing is returned when the issue has no embedding for this model.
CREATE OR REPLACE FUNCTION similar_issues(
    p_issue_id       BIGINT,
    p_model          TEXT,
    p_limit          INTEGER DEFAULT 5,
    p_min_similarity NUMERIC DEFAULT 0.80
)
RETURNS TABLE (issue_id BIGINT, number INTEGER, title TEXT, status TEXT, repository_id BIGINT, similarity NUMERIC)
LANGUAGE sql STABLE AS $$
    WITH target AS (
        SELECT e.embedding, r.project_id
          FROM issues i
          JOIN repositories r ON r.id = i.repository_id
          JOIN embeddings e   ON e.entity_type = 'issue' AND e.entity_id = i.id AND e.model = p_model
         WHERE i.id = p_issue_id
    ), scored AS (
        SELECT i.id, i.number, i.title, i.status, i.repository_id,
               round((1 - (e.embedding <=> t.embedding))::numeric, 3) AS similarity
          FROM target t
          JOIN repositories r ON r.project_id = t.project_id
          JOIN issues i       ON i.repository_id = r.id AND i.id <> p_issue_id
          JOIN embeddings e   ON e.entity_type = 'issue' AND e.entity_id = i.id AND e.model = p_model
    )
    SELECT id, number, title, status, repository_id, similarity
      FROM scored
     WHERE similarity >= p_min_similarity
     ORDER BY similarity DESC, id
     LIMIT greatest(p_limit, 0);
$$;

-- Reviewer recommendation for a pull request.
--   1. Take the p_neighbours pull requests of the same project that are most similar to it.
--   2. Everyone who reviewed or authored one of them has worked on similar code. Each such pull request adds its
--      similarity to that person's score: a review counts fully, authorship half (an author knows the code but has
--      not judged it as a reviewer).
--   3. Only members and leads of the project's teams are suggested. The pull request's author is never suggested (the
--      self-review trigger, P1-10, would refuse them), and neither is anyone who has already reviewed it.
-- evidence is how many of the similar pull requests the person reviewed or authored.
CREATE OR REPLACE FUNCTION recommend_reviewers(
    p_pr_id      BIGINT,
    p_model      TEXT,
    p_limit      INTEGER DEFAULT 3,
    p_neighbours INTEGER DEFAULT 20
)
RETURNS TABLE (user_id BIGINT, full_name TEXT, score NUMERIC, evidence BIGINT)
LANGUAGE sql STABLE AS $$
    WITH target AS (
        SELECT e.embedding, r.project_id, p.author_id
          FROM pull_requests p
          JOIN repositories r ON r.id = p.repository_id
          JOIN embeddings e   ON e.entity_type = 'pull_request' AND e.entity_id = p.id AND e.model = p_model
         WHERE p.id = p_pr_id
    ), neighbours AS (
        SELECT p.id, p.author_id, 1 - (e.embedding <=> t.embedding) AS similarity
          FROM target t
          JOIN repositories r  ON r.project_id = t.project_id
          JOIN pull_requests p ON p.repository_id = r.id AND p.id <> p_pr_id
          JOIN embeddings e    ON e.entity_type = 'pull_request' AND e.entity_id = p.id AND e.model = p_model
         WHERE (e.embedding <=> t.embedding) < 1                  -- unrelated pull requests are no evidence
         ORDER BY similarity DESC, p.id
         LIMIT greatest(p_neighbours, 0)
    ), evidence AS (
        SELECT v.reviewer_id AS user_id, n.id AS pr_id, n.similarity AS weight
          FROM neighbours n JOIN pr_reviews v ON v.pull_request_id = n.id
         WHERE v.reviewer_id IS NOT NULL
        UNION ALL
        SELECT n.author_id, n.id, 0.5 * n.similarity
          FROM neighbours n
         WHERE n.author_id IS NOT NULL
    ), eligible AS (
        SELECT tm.user_id FROM target t JOIN teams tt ON tt.project_id = t.project_id JOIN team_members tm ON tm.team_id = tt.id
        UNION
        SELECT tt.lead_id FROM target t JOIN teams tt ON tt.project_id = t.project_id WHERE tt.lead_id IS NOT NULL
    )
    SELECT u.id, u.full_name, round(sum(ev.weight)::numeric, 3) AS score, count(DISTINCT ev.pr_id) AS evidence
      FROM evidence ev
      JOIN eligible el ON el.user_id = ev.user_id
      JOIN users u     ON u.id = ev.user_id
     WHERE u.id IS DISTINCT FROM (SELECT author_id FROM target)
       AND NOT EXISTS (SELECT 1 FROM pr_reviews v WHERE v.pull_request_id = p_pr_id AND v.reviewer_id = u.id)
     GROUP BY u.id, u.full_name
    HAVING sum(ev.weight) > 0
     ORDER BY score DESC, u.id
     LIMIT greatest(p_limit, 0);
$$;
