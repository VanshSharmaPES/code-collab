import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_ERRORS, MAX_COMMENT_LENGTH, MAX_REPLY_DEPTH, parseCommentBody, parseCommentId, parseCommentTarget } from "./comment-input";
import { addComment, buildThread, listComments, type CommentDeps, type NewComment, type StoredComment } from "./comments";

const PARENT_ID = "a".repeat(24);
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const stored = (o: Partial<StoredComment> & { id: string }): StoredComment => ({
  targetType: "issue", targetId: "7", parentId: null, depth: 0, authorId: "1", authorName: "Ada", body: "hi", createdAt: at(0), ...o,
});

// A fake store and access rule: the viewer may see issue 7 and pull request 9 only (their project), never issue 8.
function fake(existing: StoredComment[] = [], allowed: (t: string, id: string, v: string) => boolean = (t, id, v) => v === "1" && ((t === "issue" && id === "7") || (t === "pull_request" && id === "9"))) {
  const inserted: NewComment[] = [];
  const calls: string[] = [];
  const deps: CommentDeps = {
    store: {
      async listForTarget(t, id) { calls.push("list"); return existing.filter((c) => c.targetType === t && c.targetId === id); },
      async findById(id) { calls.push("find"); return existing.find((c) => c.id === id) ?? null; },
      async insert(c) { calls.push("insert"); inserted.push(c); return "b".repeat(24); },
    },
    async canAccess(t, id, v) { return allowed(t, id, v); },
    async authorName(v) { return v === "1" ? "Ada" : null; },
  };
  return { deps, inserted, calls };
}

test("a valid comment is stored for the signed-in user, with the trimmed body", async () => {
  const { deps, inserted } = fake();
  const r = await addComment({ targetType: "issue", targetId: "7", body: "  Looks good\r\nto me  " }, "1", deps);
  assert.deepEqual(r, { ok: true, id: "b".repeat(24) });
  assert.equal(inserted[0].authorId, "1");
  assert.equal(inserted[0].authorName, "Ada");
  assert.equal(inserted[0].body, "Looks good\nto me");
  assert.equal(inserted[0].parentId, null);
  assert.equal(inserted[0].depth, 0);
});

test("a reply points at its parent and is one level deeper", async () => {
  const { deps, inserted } = fake([stored({ id: PARENT_ID, depth: 2 })]);
  assert.equal((await addComment({ targetType: "issue", targetId: "7", parentId: PARENT_ID.toUpperCase(), body: "reply" }, "1", deps)).ok, true);
  assert.equal(inserted[0].parentId, PARENT_ID);
  assert.equal(inserted[0].depth, 3);
});

test("a reply to a missing parent, a malformed parent id or an operator object is refused", async () => {
  for (const parentId of ["c".repeat(24), "not-an-id", "a".repeat(23), { $ne: null }, ["x"], 5]) {
    const { deps, inserted } = fake([stored({ id: PARENT_ID })]);
    assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", parentId, body: "x" }, "1", deps), { ok: false, error: "parent" });
    assert.equal(inserted.length, 0);
  }
});

test("a reply cannot attach to a comment on another target (reply-target consistency)", async () => {
  for (const other of [stored({ id: PARENT_ID, targetId: "8" }), stored({ id: PARENT_ID, targetType: "pull_request", targetId: "7" })]) {
    const { deps, inserted } = fake([other]);
    assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", parentId: PARENT_ID, body: "x" }, "1", deps), { ok: false, error: "parent" });
    assert.equal(inserted.length, 0);
  }
});

test("replies stop at the maximum depth", async () => {
  const { deps, inserted } = fake([stored({ id: PARENT_ID, depth: MAX_REPLY_DEPTH })]);
  assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", parentId: PARENT_ID, body: "x" }, "1", deps), { ok: false, error: "depth" });
  assert.equal(inserted.length, 0);
});

test("a parent whose stored depth is missing or malformed is refused, so the depth limit cannot be bypassed", async () => {
  for (const depth of [undefined, Number.NaN, null, -5]) {
    const { deps, inserted } = fake([stored({ id: PARENT_ID, depth: depth as never })]);
    assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", parentId: PARENT_ID, body: "x" }, "1", deps), { ok: false, error: "depth" });
    assert.equal(inserted.length, 0);
  }
});

test("malformed or unknown targets are refused before any database access", async () => {
  for (const [targetType, targetId] of [["issue", "abc"], ["issue", "0"], ["issue", "7; DROP"], ["issue", "-1"], ["user", "7"], [{ $ne: 1 }, "7"], [undefined, "7"]] as const) {
    const { deps, calls } = fake();
    assert.deepEqual(await addComment({ targetType, targetId, body: "x" }, "1", deps), { ok: false, error: "notFound" });
    assert.deepEqual(calls, []);
  }
});

test("a viewer outside the project cannot read or write: same answer as a target that does not exist", async () => {
  const { deps, inserted, calls } = fake([stored({ id: PARENT_ID, targetId: "8" })]);
  // Issue 8 belongs to another project; the parent lookup must not even run.
  assert.deepEqual(await addComment({ targetType: "issue", targetId: "8", parentId: PARENT_ID, body: "x" }, "1", deps), { ok: false, error: "notFound" });
  assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", body: "x" }, "2", deps), { ok: false, error: "notFound" });
  assert.equal(await listComments("issue", "8", "1", deps), null);
  assert.equal(await listComments("issue", "7", "2", deps), null);
  assert.equal(inserted.length, 0);
  assert.deepEqual(calls, []);
});

test("the author is always the signed-in user, never a value from the request", async () => {
  const { deps, inserted } = fake();
  await addComment({ targetType: "issue", targetId: "7", body: "x", authorId: "99", authorName: "Mallory" } as never, "1", deps);
  assert.equal(inserted[0].authorId, "1");
  assert.equal(inserted[0].authorName, "Ada");
});

test("a user that no longer exists cannot comment", async () => {
  const { deps } = fake(undefined, () => true);
  assert.deepEqual(await addComment({ targetType: "issue", targetId: "7", body: "x" }, "5", deps), { ok: false, error: "notFound" });
});

test("empty, whitespace-only, over-long, non-string and NUL bodies are refused", () => {
  assert.deepEqual(parseCommentBody(""), { ok: false, error: "empty" });
  assert.deepEqual(parseCommentBody(" \n\t "), { ok: false, error: "empty" });
  assert.deepEqual(parseCommentBody("x".repeat(MAX_COMMENT_LENGTH + 1)), { ok: false, error: "tooLong" });
  assert.deepEqual(parseCommentBody("x".repeat(MAX_COMMENT_LENGTH)), { ok: true, body: "x".repeat(MAX_COMMENT_LENGTH) });
  for (const v of [null, undefined, 5, { $gt: "" }, ["a"], "a\0b"]) assert.deepEqual(parseCommentBody(v), { ok: false, error: "invalid" });
});

test("hostile text is stored as plain text, unchanged: escaping is left to React when it is rendered", async () => {
  const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)> {"$where":"1"}`;
  const { deps, inserted } = fake();
  await addComment({ targetType: "issue", targetId: "7", body: hostile }, "1", deps);
  assert.equal(inserted[0].body, hostile);
});

test("ids and targets accept only their exact forms", () => {
  assert.equal(parseCommentId("AABBCCDDEEFF001122334455"), "aabbccddeeff001122334455");
  for (const v of ["", "zz".repeat(12), "a".repeat(25), { $ne: 1 }, null, undefined, 12]) assert.equal(parseCommentId(v), null);
  assert.equal(parseCommentTarget("pull_request"), "pull_request");
  for (const v of ["Issue", "comment", "", null, ["issue"], { $ne: 1 }]) assert.equal(parseCommentTarget(v), null);
});

test("a thread is nested by parent and ordered oldest first at every level", () => {
  const thread = buildThread([
    stored({ id: "3".repeat(24), parentId: "1".repeat(24), depth: 1, createdAt: at(30) }),
    stored({ id: "2".repeat(24), createdAt: at(20) }),
    stored({ id: "1".repeat(24), createdAt: at(10) }),
    stored({ id: "4".repeat(24), parentId: "1".repeat(24), depth: 1, createdAt: at(15) }),
    stored({ id: "5".repeat(24), parentId: "f".repeat(24), depth: 1, createdAt: at(40) }), // parent is gone: shown at the top
  ]);
  assert.deepEqual(thread.map((n) => n.id[0]), ["1", "2", "5"]);
  assert.deepEqual(thread[0].replies.map((n) => n.id[0]), ["4", "3"]);
});

test("listing returns the nested comments for a visible target only", async () => {
  const { deps } = fake([stored({ id: "1".repeat(24) }), stored({ id: "2".repeat(24), targetId: "8" })]);
  const thread = await listComments("issue", "7", "1", deps);
  assert.deepEqual(thread?.map((n) => n.id[0]), ["1"]);
});

test("a store failure propagates so the page can show its error state", async () => {
  const { deps } = fake();
  deps.store.insert = async () => { throw new Error("mongo down"); };
  await assert.rejects(addComment({ targetType: "issue", targetId: "7", body: "x" }, "1", deps), /mongo down/);
  deps.store.listForTarget = async () => { throw new Error("mongo down"); };
  await assert.rejects(listComments("issue", "7", "1", deps), /mongo down/);
});

test("error messages are fixed text for every code", () => {
  for (const msg of Object.values(COMMENT_ERRORS)) assert.match(msg, /^[A-Z]/);
});
