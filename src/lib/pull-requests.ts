import "server-only";
import { query } from "@/lib/db";
import {
  MERGE_ERROR_PREFIX, PR_TRANSITIONS, approveErrorCode, mergeErrorCode,
  type ActionErrorCode, type PullRequestAction, type PullRequestStatus,
} from "@/lib/pull-request-input";

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

// Close and reopen only. $1 id, $2 new status, $3 statuses the pull request may currently be in, $4 actor.
// set_config(..., true) records the actor for this transaction only, in the same statement. Approve and merge do NOT
// use this statement: approving writes a review and merging calls merge_pull_request, so the database's own rules
// apply. The status can only become open or closed here, whatever is passed. Pull requests of a GitHub mirror
// (github_url set) are never changed. The final SELECT always returns one row: the updated id (NULL when nothing was
// updated) plus the pull request's current mirror flag and status (NULL when it does not exist), so the caller can
// tell "missing", "mirror" and "wrong status" apart.
export const TRANSITION_PULL_REQUEST_SQL =
  "WITH upd AS (" +
  "UPDATE pull_requests pr SET status = $2::text, updated_at = now() " +
  "FROM (SELECT set_config('codecollab.actor_id', $4::text, true)) AS actor " +
  "WHERE pr.id = $1::bigint AND $2::text IN ('open', 'closed') AND pr.status = ANY($3::text[]) " +
  "AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = pr.repository_id AND r.github_url IS NULL) " +
  "RETURNING pr.id) " +
  "SELECT (SELECT id::text FROM upd) AS id, " +
  "(SELECT r.github_url IS NOT NULL FROM pull_requests x JOIN repositories r ON r.id = x.repository_id WHERE x.id = $1::bigint) AS mirrored, " +
  "(SELECT x.status FROM pull_requests x WHERE x.id = $1::bigint) AS status";

// Approve: $1 pull request id, $2 reviewer (the signed-in user). It inserts a real review, so the self-review trigger
// (P1-10) and UNIQUE (pull_request_id, reviewer_id) apply, and only then moves an open pull request to approved. The
// review is inserted for open or already approved pull requests of a non-mirrored repository; for an approved one only
// the review is added (the status is already right), which counts as success. One statement, so the review and the
// status change commit or fail together, and set_config gives the status-audit trigger the actor.
export const APPROVE_PULL_REQUEST_SQL =
  "WITH rev AS (" +
  "INSERT INTO pr_reviews (pull_request_id, reviewer_id, verdict) " +
  "SELECT pr.id, $2::bigint, 'approved' FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id " +
  "WHERE pr.id = $1::bigint AND pr.status IN ('open', 'approved') AND r.github_url IS NULL " +
  "RETURNING pull_request_id), " +
  "upd AS (" +
  "UPDATE pull_requests pr SET status = 'approved', updated_at = now() " +
  "FROM rev, (SELECT set_config('codecollab.actor_id', $2::text, true)) AS actor " +
  "WHERE pr.id = rev.pull_request_id AND pr.status = 'open' RETURNING pr.id) " +
  "SELECT (SELECT pull_request_id::text FROM rev) AS reviewed, (SELECT id::text FROM upd) AS updated";

// Merge: all of it is done by the procedure (status check, approval, change requests, project state, merger role,
// linked issues, audit rows, metrics, one transaction). The application only calls it, for non-mirrored pull requests.
export const MERGE_PULL_REQUEST_SQL = "CALL merge_pull_request($1::bigint, $2::bigint)";

// Used before a call that has no result of its own, and to explain why an approval did nothing.
export const PULL_REQUEST_STATE_SQL =
  "SELECT NULL::text AS id, (r.github_url IS NOT NULL) AS mirrored, pr.status AS status " +
  "FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id WHERE pr.id = $1::bigint";

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
// A rule of the database refused the change (own approval, second review, merge conditions): `code` picks the message.
export class PullRequestRuleError extends Error {
  constructor(readonly code: ActionErrorCode, readonly detail?: string) {
    super(`Pull request change refused (${code}).`);
  }
}

// The Approve/Merge/Close/Reopen buttons are shown only for pull requests that can change here.
export function canChangePullRequest(pr: Pick<PullRequestRow, "is_mirrored">): boolean {
  return !pr.is_mirrored;
}

type TransitionRow = { id?: string | null; mirrored?: boolean | null; status?: string | null; reviewed?: string | null; updated?: string | null };
type Run = RunQuery<TransitionRow>;

// Throws the reason a pull request could not be changed, from its current state: missing, GitHub mirror or wrong status.
async function explain(id: string, run: Run): Promise<never> {
  const state = (await run(PULL_REQUEST_STATE_SQL, [id]))[0];
  if (state?.status == null) throw new PullRequestNotFoundError();
  if (state.mirrored === true) throw new PullRequestMirroredError();
  throw new PullRequestStatusError(state.status);
}

async function approvePullRequest(id: string, actorId: string, run: Run): Promise<void> {
  let row: TransitionRow | undefined;
  try {
    row = (await run(APPROVE_PULL_REQUEST_SQL, [id, actorId]))[0];
  } catch (err) {
    const code = approveErrorCode((err as { code?: unknown }).code);
    if (code) throw new PullRequestRuleError(code);
    throw err;
  }
  if (row?.reviewed) return; // the review exists; the status is now approved (it already was, if `updated` is empty)
  return explain(id, run); // no review was written: missing, mirrored, or not open/approved
}

async function mergePullRequest(id: string, actorId: string, run: Run): Promise<void> {
  const state = (await run(PULL_REQUEST_STATE_SQL, [id]))[0];
  if (state?.status == null) throw new PullRequestNotFoundError();
  if (state.mirrored === true) throw new PullRequestMirroredError();
  try {
    await run(MERGE_PULL_REQUEST_SQL, [id, actorId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (!message.startsWith(MERGE_ERROR_PREFIX)) throw err;
    const code = mergeErrorCode(message);
    if (code === null) throw new PullRequestNotFoundError();
    if (code === "status") throw new PullRequestStatusError(state.status);
    throw new PullRequestRuleError(code, message);
  }
}

// Close and reopen: a plain status change. Approve and merge go through the database's own rules (see above).
export async function transitionPullRequest(
  id: string,
  action: PullRequestAction,
  actorId: string,
  run: Run = query<TransitionRow>,
): Promise<void> {
  if (action === "approve") return approvePullRequest(id, actorId, run);
  if (action === "merge") return mergePullRequest(id, actorId, run);
  const { from, to } = PR_TRANSITIONS[action];
  const row = (await run(TRANSITION_PULL_REQUEST_SQL, [id, to, from, actorId]))[0];
  if (row?.id) return;
  if (row?.status == null) throw new PullRequestNotFoundError();
  if (row.mirrored === true) throw new PullRequestMirroredError();
  throw new PullRequestStatusError(row.status);
}
