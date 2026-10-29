// Validation for comments and replies. Pure: no database, no framework imports.
export const COMMENT_TARGETS = ["issue", "pull_request"] as const;
export type CommentTarget = (typeof COMMENT_TARGETS)[number];

export const MAX_COMMENT_LENGTH = 5_000;
export const MAX_REPLY_DEPTH = 5; // a top-level comment has depth 0

export function parseCommentTarget(value: unknown): CommentTarget | null {
  return COMMENT_TARGETS.find((t) => t === value) ?? null;
}

// A MongoDB ObjectId as text: exactly 24 hex digits. Anything else (operators, objects, arrays) is refused.
export function parseCommentId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : null;
}

export type CommentBodyError = "empty" | "tooLong" | "invalid";

// Comments are plain text. The body is kept as typed (line breaks included) except for surrounding whitespace.
export function parseCommentBody(value: unknown): { ok: true; body: string } | { ok: false; error: CommentBodyError } {
  if (typeof value !== "string") return { ok: false, error: "invalid" };
  if (value.includes("\0")) return { ok: false, error: "invalid" };
  const body = value.replace(/\r\n?/g, "\n").trim();
  if (body === "") return { ok: false, error: "empty" };
  if (body.length > MAX_COMMENT_LENGTH) return { ok: false, error: "tooLong" };
  return { ok: true, body };
}

// Messages for a failed comment, picked by a fixed code in the redirect URL (never free text).
export const COMMENT_ERRORS = {
  empty: "Write something before posting.",
  tooLong: `A comment can be at most ${MAX_COMMENT_LENGTH} characters.`,
  invalid: "That comment could not be read.",
  parent: "The comment you replied to no longer exists.",
  depth: "This thread is nested too deeply to reply to. Reply to a higher comment instead.",
  failed: "The comment could not be saved right now. Please try again.",
} as const;
export type CommentErrorCode = keyof typeof COMMENT_ERRORS;
