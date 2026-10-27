import "server-only";
import { query } from "@/lib/db";
import { PR_TRANSITIONS, type PullRequestAction, type PullRequestStatus } from "@/lib/pull-request-input";

export { PAGE_SIZE, listRepositories, type RepositoryOption } from "@/lib/issues";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// Names only: the users table's email and password_hash are never selected here.
const PR_COLUMNS =
  "pr.id::text AS id, pr.number, pr.title, pr.description, pr.status, pr.created_at, pr.updated_at, pr.merged_at, " +
  "pr.repository_id::text AS repository_id, r.name AS repository_name, p.name AS project_name, " +
  "a.full_name AS author_name, m.full_name AS merged_by_name, (r.github_url IS NOT NULL) AS is_mirrored";
const PR_FROM =
  "FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id JOIN projects p ON p.id = r.project_id " +
  "LEFT JOIN users a ON a.id = pr.author_id LEFT JOIN users m ON m.id = pr.merged_by";

// Optional filters are bound parameters: a NULL means "no filter".
const PR_WHERE = "WHERE ($1::bigint IS NULL OR pr.repository_id = $1::bigint) AND ($2::text IS NULL OR pr.status = $2::text)";
export const LIST_PULL_REQUESTS_SQL = `SELECT ${PR_COLUMNS} ${PR_FROM} ${PR_WHERE} ORDER BY pr.updated_at DESC, pr.id DESC LIMIT $3 OFFSET $4`;
export const COUNT_PULL_REQUESTS_SQL = `SELECT count(*)::int AS n FROM pull_requests pr ${PR_WHERE}`;
export const GET_PULL_REQUEST_SQL = `SELECT ${PR_COLUMNS} ${PR_FROM} WHERE pr.id = $1::bigint`;

// $1 id, $2 new status, $3 statuses the pull request may currently be in, $4 actor.
// set_config(..., true) records the actor for this transaction only, in the same statement. Merging also records who
// merged and when (the table requires merged_at exactly when the status is merged). Pull requests of a GitHub mirror
// (github_url set) are never changed. The final SELECT always returns one row: the updated id (NULL when nothing was
// updated) plus the pull request's current mirror flag and status (NULL when it does not exist), so the caller can
// tell "missing", "mirror" and "wrong status" apart.
export const TRANSITION_PULL_REQUEST_SQL =
  "WITH upd AS (" +
  "UPDATE pull_requests pr SET status = $2::text, updated_at = now(), " +
  "merged_by = CASE WHEN $2::text = 'merged' THEN $4::bigint ELSE pr.merged_by END, " +
  "merged_at = CASE WHEN $2::text = 'merged' THEN now() ELSE pr.merged_at END " +
  "FROM (SELECT set_config('codecollab.actor_id', $4::text, true)) AS actor " +
  "WHERE pr.id = $1::bigint AND pr.status = ANY($3::text[]) " +
  "AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = pr.repository_id AND r.github_url IS NULL) " +
  "RETURNING pr.id) " +
  "SELECT (SELECT id::text FROM upd) AS id, " +
  "(SELECT r.github_url IS NOT NULL FROM pull_requests x JOIN repositories r ON r.id = x.repository_id WHERE x.id = $1::bigint) AS mirrored, " +
  "(SELECT x.status FROM pull_requests x WHERE x.id = $1::bigint) AS status";

export type PullRequestRow = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: PullRequestStatus;
  created_at: Date | string;
  updated_at: Date | string;
  merged_at: Date | string | null;
  repository_id: string;
  repository_name: string;
  project_name: string;
  author_name: string | null;
  merged_by_name: string | null;
  is_mirrored: boolean; // the repository mirrors GitHub (has a github_url), so the pull request is read-only here
};

export type PullRequestFilters = { repositoryId: string | null; status: string | null };

export async function listPullRequests(
  filters: PullRequestFilters,
  page: number,
  pageSize: number,
  run: RunQuery<PullRequestRow> = query<PullRequestRow>,
): Promise<PullRequestRow[]> {
  return run(LIST_PULL_REQUESTS_SQL, [filters.repositoryId, filters.status, pageSize, (page - 1) * pageSize]);
}

export async function countPullRequests(filters: PullRequestFilters, run: RunQuery<{ n: number }> = query<{ n: number }>): Promise<number> {
  return (await run(COUNT_PULL_REQUESTS_SQL, [filters.repositoryId, filters.status]))[0]?.n ?? 0;
}

export async function getPullRequest(id: string, run: RunQuery<PullRequestRow> = query<PullRequestRow>): Promise<PullRequestRow | null> {
  return (await run(GET_PULL_REQUEST_SQL, [id]))[0] ?? null;
}

export const PR_MIRRORED_READ_ONLY_MESSAGE = "GitHub-mirrored pull requests are read-only.";
export class PullRequestNotFoundError extends Error {}
export class PullRequestMirroredError extends Error {
  constructor() {
    super(PR_MIRRORED_READ_ONLY_MESSAGE);
  }
}
export class PullRequestStatusError extends Error {
  constructor(readonly current: string) {
    super(`This pull request is ${current}, so that action is not available.`);
  }
}

// The Approve/Merge/Close/Reopen buttons are shown only for pull requests that can change here.
export function canChangePullRequest(pr: Pick<PullRequestRow, "is_mirrored">): boolean {
  return !pr.is_mirrored;
}

type TransitionRow = { id: string | null; mirrored: boolean | null; status: string | null };

export async function transitionPullRequest(
  id: string,
  action: PullRequestAction,
  actorId: string,
  run: RunQuery<TransitionRow> = query<TransitionRow>,
): Promise<void> {
  const { from, to } = PR_TRANSITIONS[action];
  const row = (await run(TRANSITION_PULL_REQUEST_SQL, [id, to, from, actorId]))[0];
  if (row?.id) return;
  if (row?.status == null) throw new PullRequestNotFoundError();
  if (row.mirrored === true) throw new PullRequestMirroredError();
  throw new PullRequestStatusError(row.status);
}
