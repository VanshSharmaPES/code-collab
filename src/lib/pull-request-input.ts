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
  status: "That action is not available for this pull request's current status.",
  failed: "The pull request could not be updated right now. Please try again.",
} as const;
export type ActionErrorCode = keyof typeof ACTION_ERRORS;
