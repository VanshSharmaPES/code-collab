-- P1-14: indexes chosen by measurement. See docs/index_tuning.md for the evidence.
-- Each one was confirmed in EXPLAIN ANALYZE output on a copy with 1,000,000 commits.

-- Counting a member's commits in a repository (contribution_counts, behind every score).
-- Both columns are in the index, so the count is answered from the index alone.
CREATE INDEX idx_commits_repo_author ON commits (repository_id, author_id);

-- Counting a member's pull requests, and how many were merged, in a repository.
CREATE INDEX idx_pull_requests_repo_author ON pull_requests (repository_id, author_id, status);

-- Finding a member's reviews together with the pull requests they belong to.
CREATE INDEX idx_pr_reviews_reviewer_pr ON pr_reviews (reviewer_id, pull_request_id);

-- Q2: a partial index holding only unresolved high and critical issues, roughly one
-- row in seven, ordered by when they were last touched.
CREATE INDEX idx_issues_unresolved_urgent ON issues (updated_at)
    WHERE status IN ('open', 'in_progress') AND priority IN ('high', 'critical');

-- Superseded by idx_pr_reviews_reviewer_pr, which starts with the same column.
DROP INDEX IF EXISTS idx_pr_reviews_reviewer;
