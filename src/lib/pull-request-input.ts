// Statuses and allowed status changes for pull requests. Pure: no database, no framework imports.
export const PR_STATUSES = ["open", "approved", "merged", "closed"] as const;
export type PullRequestStatus = (typeof PR_STATUSES)[number];

export const PR_ACTIONS = ["approve", "merge", "close", "reopen"] as const;
export type PullRequestAction = (typeof PR_ACTIONS)[number];

// Each action moves a pull request from one of the `from` statuses to `to`. A merged pull request never changes again.
export const PR_TRANSITIONS: Record<PullRequestAction, { from: readonly PullRequestStatus[]; to: PullRequestStatus; label: string }> = {
  approve: { from: ["open"], to: "approved", label: "Approve" },
  merge: { from: ["approved"], to: "merged", label: "Merge" },
  close: { from: ["open", "approved"], to: "closed", label: "Close" },
  reopen: { from: ["closed"], to: "open", label: "Reopen" },
};

export function isPullRequestStatus(value: string): value is PullRequestStatus {
  return (PR_STATUSES as readonly string[]).includes(value);
}

export function parsePullRequestAction(value: unknown): PullRequestAction | null {
  return typeof value === "string" && (PR_ACTIONS as readonly string[]).includes(value) ? (value as PullRequestAction) : null;
}

// The actions that make sense for a pull request in this status, in display order.
export function availableActions(status: PullRequestStatus): PullRequestAction[] {
  return PR_ACTIONS.filter((a) => PR_TRANSITIONS[a].from.includes(status));
}

// Messages for a failed status change, picked by a fixed code in the redirect URL (never free text).
export const ACTION_ERRORS = {
  mirrored: "GitHub-mirrored pull requests are read-only.",
  forbidden: "Only the author, a team lead or the mentor can close or reopen this pull request.",
  status: "That action is not available for this pull request's current status.",
  failed: "The pull request could not be updated right now. Please try again.",
  selfApproval: "You can't approve your own pull request.",
  alreadyReviewed: "You have already reviewed this pull request.",
  noApproval: "This pull request has no approving review yet.",
  changesRequested: "This pull request has an unresolved change request.",
  projectInactive: "Merging is disabled because the project is not active.",
  notMerger: "Only a team lead or the project's mentor can merge this pull request.",
  mergeRefused: "The merge was refused. Nothing was changed.",
} as const;
export type ActionErrorCode = keyof typeof ACTION_ERRORS;

// PostgreSQL error codes the approval can run into: the self-review trigger raises check_violation, and
// UNIQUE (pull_request_id, reviewer_id) raises unique_violation.
export const PG_CHECK_VIOLATION = "23514";
export const PG_UNIQUE_VIOLATION = "23505";

export function approveErrorCode(pgCode: unknown): ActionErrorCode | null {
  if (pgCode === PG_CHECK_VIOLATION) return "selfApproval";
  if (pgCode === PG_UNIQUE_VIOLATION) return "alreadyReviewed";
  return null;
}

// merge_pull_request (db/schema/03_merge_pull_request.sql) raises messages that start with this prefix.
export const MERGE_ERROR_PREFIX = "merge_pull_request:";

// Maps one of the procedure's messages to a fixed code, so the page never shows database text. Messages that are
// not recognised become "mergeRefused". "does not exist" is reported as null: the caller treats it as a missing PR.
export function mergeErrorCode(message: string): ActionErrorCode | null {
  if (!message.startsWith(MERGE_ERROR_PREFIX)) return "failed";
  if (/ does not exist$/.test(message)) return null;
  if (/only approved pull requests can be merged/.test(message)) return "status";
  if (/has no approving review/.test(message)) return "noApproval";
  if (/has an unresolved change request/.test(message)) return "changesRequested";
  if (/merging is disabled/.test(message)) return "projectInactive";
  if (/is not a lead or mentor of project/.test(message)) return "notMerger";
  return "mergeRefused";
}
