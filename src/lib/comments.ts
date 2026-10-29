// Comment threads (P2-12) on issues and pull requests, stored in the MongoDB `comments` collection.
//
// Document: { targetType: "issue" | "pull_request", targetId: PostgreSQL id as text, parentId: ObjectId | null,
//             depth: number, authorId: PostgreSQL user id as text, authorName: string, body: string, createdAt: Date }
// Pure: the database access is injected (see comments-server.ts), so the rules below are testable without a server.
//
// Every read and write first asks `canAccess`, which is the same participant check the issue and pull request
// pages use. A viewer who may not see the target gets the same "not found" as for a target that does not exist.
import { parseId } from "@/lib/issue-input";
import { MAX_REPLY_DEPTH, parseCommentBody, parseCommentId, parseCommentTarget, type CommentBodyError, type CommentTarget } from "@/lib/comment-input";

export const MAX_COMMENTS_PER_TARGET = 500;

export type StoredComment = {
  id: string; targetType: CommentTarget; targetId: string; parentId: string | null; depth: number;
  authorId: string; authorName: string; body: string; createdAt: Date;
};
export type NewComment = Omit<StoredComment, "id">;

export type CommentStore = {
  // Oldest first, at most `limit`.
  listForTarget(targetType: CommentTarget, targetId: string, limit: number): Promise<StoredComment[]>;
  findById(id: string): Promise<StoredComment | null>;
  insert(comment: NewComment): Promise<string>;
};
export type CommentDeps = {
  store: CommentStore;
  canAccess(targetType: CommentTarget, targetId: string, viewerId: string): Promise<boolean>;
  authorName(viewerId: string): Promise<string | null>;
};

export type CommentNode = StoredComment & { replies: CommentNode[] };

// Oldest first at every level; a reply whose parent is missing from the list is shown at the top level.
export function buildThread(comments: readonly StoredComment[]): CommentNode[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const nodes = new Map<string, CommentNode>(sorted.map((c) => [c.id, { ...c, replies: [] }]));
  const roots: CommentNode[] = [];
  for (const c of sorted) {
    const node = nodes.get(c.id) as CommentNode;
    const parent = c.parentId === null ? undefined : nodes.get(c.parentId);
    (parent ? parent.replies : roots).push(node);
  }
  return roots;
}

// Null when the target does not exist or the viewer may not see it.
export async function listComments(targetType: CommentTarget, targetId: string, viewerId: string, deps: CommentDeps): Promise<CommentNode[] | null> {
  if (parseId(targetId) === null || !(await deps.canAccess(targetType, targetId, viewerId))) return null;
  return buildThread(await deps.store.listForTarget(targetType, targetId, MAX_COMMENTS_PER_TARGET));
}

export type AddCommentInput = { targetType: unknown; targetId: string; parentId?: unknown; body: unknown };
export type AddCommentResult =
  | { ok: true; id: string }
  | { ok: false; error: CommentBodyError | "notFound" | "parent" | "depth" };

export async function addComment(input: AddCommentInput, viewerId: string, deps: CommentDeps): Promise<AddCommentResult> {
  const targetType = parseCommentTarget(input.targetType);
  if (targetType === null) return { ok: false, error: "notFound" };
  const body = parseCommentBody(input.body);
  if (!body.ok) return body;
  // Access comes before the parent lookup, so nobody learns whether a comment exists in a project they cannot see.
  if (parseId(input.targetId) === null || !(await deps.canAccess(targetType, input.targetId, viewerId))) return { ok: false, error: "notFound" };

  let parentId: string | null = null;
  let depth = 0;
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== "") {
    parentId = parseCommentId(input.parentId);
    if (parentId === null) return { ok: false, error: "parent" };
    const parent = await deps.store.findById(parentId);
    // The reply must belong to the same issue or pull request as the comment it answers.
    if (parent === null || parent.targetType !== targetType || parent.targetId !== input.targetId) return { ok: false, error: "parent" };
    // A stored depth that is not a non-negative integer (missing, NaN, null, negative) would defeat the limit below.
    if (!Number.isInteger(parent.depth) || parent.depth < 0) return { ok: false, error: "depth" };
    depth = parent.depth + 1;
    if (depth > MAX_REPLY_DEPTH) return { ok: false, error: "depth" };
  }

  const authorName = await deps.authorName(viewerId);
  if (authorName === null) return { ok: false, error: "notFound" };
  const id = await deps.store.insert({ targetType, targetId: input.targetId, parentId, depth, authorId: viewerId, authorName, body: body.body, createdAt: new Date() });
  return { ok: true, id };
}
