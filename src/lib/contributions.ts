import "server-only";
import { query } from "@/lib/db";
import { managerSql, participantSql } from "@/lib/project-access";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// How many evidence rows each list shows. The totals above the lists come from the counts, not from the lists.
export const EVIDENCE_LIMIT = 50;

// The counting rules and the weights live in the database (db/schema/05_contribution_score.sql, P1-12):
// contribution_counts() and score_from_counts(). The query below calls them, so this page shows the same numbers as
// the SQL function and nothing is scored in TypeScript. Those functions come from db/schema/05_contribution_score.sql,
// which must be applied before this page works.
export type ContributionCounts = { commits: number; prs_opened: number; prs_merged: number; reviews_given: number; issues_closed: number };

// A link to the commit on GitHub, only for a plain https://github.com/<owner>/<repo> repository address.
export function commitUrl(githubUrl: string | null, sha: string): string | null {
  const m = githubUrl ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(githubUrl) : null;
  return m && /^[0-9a-f]{7,64}$/i.test(sha) ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null;
}

// Who may see what is the shared project policy in src/lib/project-access.ts (P1-07); nothing here defines its own:
//   * the mentor of a project and any team lead of that project (managerSql) see every member of that project,
//     including members of other teams;
//   * a regular team member sees only their own row;
//   * everyone else, including a manager of a different project, sees nothing.
// A project shows up in the list only if the viewer is a participant of it (participantSql).
// The viewer is always the signed-in user from the session, never a request parameter.
export type ProjectOption = { id: string; name: string };
export const LIST_PROJECTS_SQL =
  `SELECT p.id::text AS id, p.name FROM projects p WHERE ${participantSql("$1", "p.id")} ORDER BY p.name, p.id`;

// Members are the users on a team of the project (a person on two teams counts once). The counts and the score come from
// contribution_counts() and score_from_counts(); the table's BIGINT and NUMERIC results are cast to int and float8
// because node-postgres returns the former types as strings. An opened PR is counted (prs_opened) but is not an
// argument of score_from_counts(), so it does not score.
// $1 project, $2 narrows to one user (or NULL), $3 the viewer: only the members the viewer may see are returned (see the
// policy above). The members are taken for $1 only, so being a manager elsewhere gives no access here.
// Names only: the users table's email and password_hash are never selected here.
export const MEMBER_CONTRIBUTIONS_SQL =
  "SELECT u.id::text AS user_id, u.full_name, u.role, " +
  "c.commits::int AS commits, c.prs_opened::int AS prs_opened, c.prs_merged::int AS prs_merged, " +
  "c.reviews_given::int AS reviews_given, c.issues_closed::int AS issues_closed, " +
  "score_from_counts(c.commits, c.prs_merged, c.reviews_given, c.issues_closed)::float8 AS score " +
  "FROM (SELECT DISTINCT tm.user_id, t.project_id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.project_id = $1::bigint) m " +
  "JOIN users u ON u.id = m.user_id CROSS JOIN LATERAL contribution_counts(u.id, $1::bigint) c " +
  `WHERE ($2::bigint IS NULL OR u.id = $2::bigint) AND (${managerSql("$3", "m.project_id")} OR u.id = $3::bigint) ` +
  "ORDER BY u.full_name, u.id";

// Evidence: the rows behind each count, newest first. $1 project, $2 user, $3 row limit. Each query uses the same
// conditions as the counts in contribution_counts(). They take no viewer: getMemberEvidence runs them only after the
// member query has confirmed the viewer may see that user, so they follow exactly the same visibility rule.
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
// What the query returns. The casts make these numbers, but a driver or a changed cast could still hand back strings.
type MemberRow = { [K in keyof MemberContribution]: MemberContribution[K] | string };

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

// Normalises the database row only; the score itself is whatever score_from_counts() returned.
export const toMember = (row: MemberRow): MemberContribution => ({
  user_id: String(row.user_id), full_name: String(row.full_name), role: String(row.role),
  commits: Number(row.commits), prs_opened: Number(row.prs_opened), prs_merged: Number(row.prs_merged),
  reviews_given: Number(row.reviews_given), issues_closed: Number(row.issues_closed), score: Number(row.score),
});

export async function listProjects(viewerId: string, run: RunQuery<ProjectOption> = query<ProjectOption>): Promise<ProjectOption[]> {
  return run(LIST_PROJECTS_SQL, [viewerId]);
}

// Which project the page shows. No ?project= at all: the first one the viewer can see (null when they see none).
// A ?project= that is malformed or not one of the viewer's projects is "not found", the same answer for a project that
// does not exist and one the viewer may not see, so the page does not reveal which projects exist.
export function pickProject(projects: ProjectOption[], requested: string | string[] | undefined, parse: (v: string) => string | null): ProjectOption | null | "notFound" {
  if (requested === undefined) return projects[0] ?? null;
  const id = typeof requested === "string" ? parse(requested) : null;
  return projects.find((p) => p.id === id) ?? "notFound";
}

// The SQL orders by name only so the result is stable; this sorts by score, highest first, ties by name.
export async function listMemberContributions(projectId: string, viewerId: string, run: RunQuery<MemberRow> = query<MemberRow>): Promise<MemberContribution[]> {
  const rows = (await run(MEMBER_CONTRIBUTIONS_SQL, [projectId, null, viewerId])).map(toMember);
  return rows.sort((a, b) => b.score - a.score || a.full_name.localeCompare(b.full_name));
}

// Null when the user is not a member of the project, or the viewer may not see them (the page shows a 404 for both).
export async function getMemberEvidence(
  projectId: string,
  userId: string,
  viewerId: string,
  run: RunQuery<never> = query as RunQuery<never>,
): Promise<MemberEvidence | null> {
  const q = <T>(text: string, params: readonly unknown[]) => (run as unknown as RunQuery<T>)(text, params);
  const row = (await q<MemberRow>(MEMBER_CONTRIBUTIONS_SQL, [projectId, userId, viewerId]))[0];
  if (!row) return null;
  const args = [projectId, userId, EVIDENCE_LIMIT];
  const [commits, pullRequests, reviews, issues] = await Promise.all([
    q<CommitEvidence>(COMMIT_EVIDENCE_SQL, args),
    q<PullRequestEvidence>(PULL_REQUEST_EVIDENCE_SQL, args),
    q<ReviewEvidence>(REVIEW_EVIDENCE_SQL, args),
    q<IssueEvidence>(ISSUE_EVIDENCE_SQL, args),
  ]);
  return { member: toMember(row), commits, pullRequests, reviews, issues };
}
