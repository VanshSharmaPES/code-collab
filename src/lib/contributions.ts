import "server-only";
import { query } from "@/lib/db";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// How many evidence rows each list shows. The totals above the lists come from the counts, not from the lists.
export const EVIDENCE_LIMIT = 50;

// The counting rules and weights are the ones in db/schema/05_contribution_score.sql (P1-12): commit 1, merged PR 5,
// review 3, closed issue 2. They are written out here because that file is not applied to every database yet, and the
// page must show the same numbers as the SQL function.
export type ContributionCounts = { commits: number; prs_opened: number; prs_merged: number; reviews_given: number; issues_closed: number };
export const SCORE_WEIGHTS = { commits: 1, prs_merged: 5, reviews_given: 3, issues_closed: 2 } as const;

export function contributionScore(c: ContributionCounts): number {
  return (
    SCORE_WEIGHTS.commits * c.commits +
    SCORE_WEIGHTS.prs_merged * c.prs_merged +
    SCORE_WEIGHTS.reviews_given * c.reviews_given +
    SCORE_WEIGHTS.issues_closed * c.issues_closed
  );
}

// A link to the commit on GitHub, only for a plain https://github.com/<owner>/<repo> repository address.
export function commitUrl(githubUrl: string | null, sha: string): string | null {
  const m = githubUrl ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(githubUrl) : null;
  return m && /^[0-9a-f]{7,64}$/i.test(sha) ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null;
}

export type ProjectOption = { id: string; name: string };
export const LIST_PROJECTS_SQL = "SELECT id::text AS id, name FROM projects ORDER BY name, id";

// Members are the users on a team of the project (a person on two teams counts once). Every count is a correlated
// subquery, so joining commits, pull requests and reviews cannot multiply rows into each other. $2 narrows to one user.
// Names only: the users table's email and password_hash are never selected here.
export const MEMBER_CONTRIBUTIONS_SQL =
  "SELECT u.id::text AS user_id, u.full_name, u.role, " +
  "(SELECT count(*)::int FROM commits c JOIN repositories r ON r.id = c.repository_id " +
  "  WHERE r.project_id = $1::bigint AND c.author_id = u.id) AS commits, " +
  "(SELECT count(*)::int FROM pull_requests p JOIN repositories r ON r.id = p.repository_id " +
  "  WHERE r.project_id = $1::bigint AND p.author_id = u.id) AS prs_opened, " +
  "(SELECT count(*)::int FROM pull_requests p JOIN repositories r ON r.id = p.repository_id " +
  "  WHERE r.project_id = $1::bigint AND p.author_id = u.id AND p.status = 'merged') AS prs_merged, " +
  "(SELECT count(*)::int FROM pr_reviews rv JOIN pull_requests p ON p.id = rv.pull_request_id " +
  "  JOIN repositories r ON r.id = p.repository_id WHERE r.project_id = $1::bigint AND rv.reviewer_id = u.id) AS reviews_given, " +
  "(SELECT count(DISTINCT l.issue_id)::int FROM pr_issue_links l JOIN pull_requests p ON p.id = l.pull_request_id " +
  "  JOIN repositories r ON r.id = p.repository_id JOIN issues i ON i.id = l.issue_id " +
  "  WHERE r.project_id = $1::bigint AND p.author_id = u.id AND p.status = 'merged' AND i.status = 'closed') AS issues_closed " +
  "FROM users u WHERE ($2::bigint IS NULL OR u.id = $2::bigint) AND u.id IN " +
  "(SELECT tm.user_id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.project_id = $1::bigint) " +
  "ORDER BY u.full_name, u.id";

// Evidence: the rows behind each count, newest first. $1 project, $2 user, $3 row limit. Each query uses the same
// conditions as its count above.
export const COMMIT_EVIDENCE_SQL =
  "SELECT c.id::text AS id, c.sha, c.message, c.additions, c.deletions, c.committed_at, r.name AS repository_name, r.github_url " +
  "FROM commits c JOIN repositories r ON r.id = c.repository_id " +
  "WHERE r.project_id = $1::bigint AND c.author_id = $2::bigint ORDER BY c.committed_at DESC, c.id DESC LIMIT $3";
export const PULL_REQUEST_EVIDENCE_SQL =
  "SELECT p.id::text AS id, p.number, p.title, p.status, p.updated_at, p.merged_at, r.name AS repository_name " +
  "FROM pull_requests p JOIN repositories r ON r.id = p.repository_id " +
  "WHERE r.project_id = $1::bigint AND p.author_id = $2::bigint ORDER BY p.updated_at DESC, p.id DESC LIMIT $3";
export const REVIEW_EVIDENCE_SQL =
  "SELECT rv.id::text AS id, rv.verdict, rv.submitted_at, p.id::text AS pull_request_id, p.number, p.title, r.name AS repository_name " +
  "FROM pr_reviews rv JOIN pull_requests p ON p.id = rv.pull_request_id JOIN repositories r ON r.id = p.repository_id " +
  "WHERE r.project_id = $1::bigint AND rv.reviewer_id = $2::bigint ORDER BY rv.submitted_at DESC, rv.id DESC LIMIT $3";
// One row per closed issue, with the merged pull request of the user that closed it (the most recent, if several).
export const ISSUE_EVIDENCE_SQL =
  "SELECT * FROM (SELECT DISTINCT ON (i.id) i.id::text AS id, i.number, i.title, i.closed_at, r.name AS repository_name, " +
  "p.id::text AS pull_request_id, p.number AS pull_request_number " +
  "FROM pr_issue_links l JOIN pull_requests p ON p.id = l.pull_request_id JOIN repositories r ON r.id = p.repository_id " +
  "JOIN issues i ON i.id = l.issue_id " +
  "WHERE r.project_id = $1::bigint AND p.author_id = $2::bigint AND p.status = 'merged' AND i.status = 'closed' " +
  "ORDER BY i.id, p.merged_at DESC, p.id DESC) x ORDER BY x.closed_at DESC NULLS LAST, x.id DESC LIMIT $3";

export type MemberContribution = ContributionCounts & { user_id: string; full_name: string; role: string; score: number };
type MemberRow = ContributionCounts & { user_id: string; full_name: string; role: string };

export type CommitEvidence = { id: string; sha: string; message: string; additions: number; deletions: number; committed_at: Date | string; repository_name: string; github_url: string | null };
export type PullRequestEvidence = { id: string; number: number; title: string; status: string; updated_at: Date | string; merged_at: Date | string | null; repository_name: string };
export type ReviewEvidence = { id: string; verdict: string; submitted_at: Date | string; pull_request_id: string; number: number; title: string; repository_name: string };
export type IssueEvidence = { id: string; number: number; title: string; closed_at: Date | string | null; repository_name: string; pull_request_id: string; pull_request_number: number };
export type MemberEvidence = {
  member: MemberContribution;
  commits: CommitEvidence[];
  pullRequests: PullRequestEvidence[];
  reviews: ReviewEvidence[];
  issues: IssueEvidence[];
};

const withScore = (row: MemberRow): MemberContribution => ({ ...row, score: contributionScore(row) });

export async function listProjects(run: RunQuery<ProjectOption> = query<ProjectOption>): Promise<ProjectOption[]> {
  return run(LIST_PROJECTS_SQL, []);
}

// Highest score first; ties by name.
export async function listMemberContributions(projectId: string, run: RunQuery<MemberRow> = query<MemberRow>): Promise<MemberContribution[]> {
  const rows = (await run(MEMBER_CONTRIBUTIONS_SQL, [projectId, null])).map(withScore);
  return rows.sort((a, b) => b.score - a.score || a.full_name.localeCompare(b.full_name));
}

// Null when the user is not a member of the project.
export async function getMemberEvidence(
  projectId: string,
  userId: string,
  run: RunQuery<never> = query as RunQuery<never>,
): Promise<MemberEvidence | null> {
  const q = <T>(text: string, params: readonly unknown[]) => (run as unknown as RunQuery<T>)(text, params);
  const row = (await q<MemberRow>(MEMBER_CONTRIBUTIONS_SQL, [projectId, userId]))[0];
  if (!row) return null;
  const args = [projectId, userId, EVIDENCE_LIMIT];
  const [commits, pullRequests, reviews, issues] = await Promise.all([
    q<CommitEvidence>(COMMIT_EVIDENCE_SQL, args),
    q<PullRequestEvidence>(PULL_REQUEST_EVIDENCE_SQL, args),
    q<ReviewEvidence>(REVIEW_EVIDENCE_SQL, args),
    q<IssueEvidence>(ISSUE_EVIDENCE_SQL, args),
  ]);
  return { member: withScore(row), commits, pullRequests, reviews, issues };
}
