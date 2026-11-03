import "server-only";
import { ObjectId } from "mongodb";
import { query } from "@/lib/db";
import { getMongoDb } from "@/lib/mongo";
import { COLLECTIONS } from "@/lib/mongo-config";
import { getIssue } from "@/lib/issues";
import { getPullRequest } from "@/lib/pull-requests";
import { parseId } from "@/lib/issue-input";
import { parseCommentId } from "@/lib/comment-input";
import type { CommentDeps, CommentStore, StoredComment } from "@/lib/comments";

type Doc = Omit<StoredComment, "id" | "parentId"> & { _id: ObjectId; parentId: ObjectId | null };

const toComment = (d: Doc): StoredComment => ({
  id: d._id.toHexString(), targetType: d.targetType, targetId: d.targetId, parentId: d.parentId?.toHexString() ?? null,
  depth: d.depth, authorId: d.authorId, authorName: d.authorName, body: d.body, createdAt: d.createdAt,
});

const store: CommentStore = {
  async listForTarget(targetType, targetId, limit) {
    // targetType and targetId are validated values here, and are bound as plain strings.
    const docs = await getMongoDb().collection<Doc>(COLLECTIONS.comments).find({ targetType, targetId: String(targetId) }).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray();
    return docs.map(toComment);
  },
  async findById(id) {
    const oid = parseCommentId(id);
    if (oid === null) return null;
    const doc = await getMongoDb().collection<Doc>(COLLECTIONS.comments).findOne({ _id: new ObjectId(oid) });
    return doc ? toComment(doc) : null;
  },
  async insert(c) {
    const { acknowledged, insertedId } = await getMongoDb().collection(COLLECTIONS.comments).insertOne({ ...c, parentId: c.parentId === null ? null : new ObjectId(c.parentId) });
    if (!acknowledged) throw new Error("The comment was not acknowledged.");
    return insertedId.toHexString();
  },
};

export const commentDeps: CommentDeps = {
  store,
  // The same participant-scoped lookups the issue and pull request pages use: null for "missing" and "not yours".
  async canAccess(targetType, targetId, viewerId) {
    if (parseId(targetId) === null) return false;
    return (targetType === "issue" ? await getIssue(targetId, viewerId) : await getPullRequest(targetId, viewerId)) !== null;
  },
  async authorName(viewerId) {
    return (await query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1::bigint", [viewerId]))[0]?.full_name ?? null;
  },
};
