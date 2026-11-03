-- P1-12: contribution scoring.
--
-- Three small functions so that each rule is written exactly once:
--   contribution_counts()   what a user did in a project (the definitions of each count)
--   score_from_counts()     the weights, and nothing else
--   contribution_score()    the two combined; this is the function applications call
--
-- Definitions (per project):
--   commits        commits authored by the user in the project's repositories
--   prs_opened     pull requests authored by the user
--   prs_merged     of those, the ones that were merged
--   reviews_given  reviews written by the user on the project's pull requests
--   issues_closed  distinct closed issues linked to a merged pull request the user authored
--
-- Weights: commit 1, merged PR 5, review 3, closed issue 2. Opening a PR that is not
-- merged scores nothing on its own, so abandoned work does not inflate the score.

CREATE OR REPLACE FUNCTION contribution_counts(p_user_id BIGINT, p_project_id BIGINT)
RETURNS TABLE (commits BIGINT, prs_opened BIGINT, prs_merged BIGINT,
               reviews_given BIGINT, issues_closed BIGINT)
LANGUAGE sql STABLE AS $$
    SELECT
        (SELECT count(*) FROM commits c
           JOIN repositories r ON r.id = c.repository_id
          WHERE r.project_id = p_project_id AND c.author_id = p_user_id),
        (SELECT count(*) FROM pull_requests p
           JOIN repositories r ON r.id = p.repository_id
          WHERE r.project_id = p_project_id AND p.author_id = p_user_id),
        (SELECT count(*) FROM pull_requests p
           JOIN repositories r ON r.id = p.repository_id
          WHERE r.project_id = p_project_id AND p.author_id = p_user_id AND p.status = 'merged'),
        (SELECT count(*) FROM pr_reviews rv
           JOIN pull_requests p ON p.id = rv.pull_request_id
           JOIN repositories r ON r.id = p.repository_id
          WHERE r.project_id = p_project_id AND rv.reviewer_id = p_user_id),
        (SELECT count(DISTINCT l.issue_id) FROM pr_issue_links l
           JOIN pull_requests p ON p.id = l.pull_request_id
           JOIN repositories r ON r.id = p.repository_id
           JOIN issues i ON i.id = l.issue_id
          WHERE r.project_id = p_project_id AND p.author_id = p_user_id
            AND p.status = 'merged' AND i.status = 'closed');
$$;

CREATE OR REPLACE FUNCTION score_from_counts(
    p_commits BIGINT, p_prs_merged BIGINT, p_reviews_given BIGINT, p_issues_closed BIGINT
) RETURNS NUMERIC(10,2)
LANGUAGE sql IMMUTABLE AS $$
    SELECT (1 * coalesce(p_commits, 0)
          + 5 * coalesce(p_prs_merged, 0)
          + 3 * coalesce(p_reviews_given, 0)
          + 2 * coalesce(p_issues_closed, 0))::numeric(10,2);
$$;

CREATE OR REPLACE FUNCTION contribution_score(p_user_id BIGINT, p_project_id BIGINT)
RETURNS NUMERIC(10,2)
LANGUAGE sql STABLE AS $$
    SELECT score_from_counts(c.commits, c.prs_merged, c.reviews_given, c.issues_closed)
      FROM contribution_counts(p_user_id, p_project_id) c;
$$;
