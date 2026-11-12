// Unit tests with a fake database and a fake embedder: they check the logic and the SQL text, not pgvector.
// The real pgvector behaviour is covered by scripts/embeddings.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DIMENSIONS, MODEL_NAME } from "../src/lib/embedding-model";
import {
  BATCH_SIZE, COUNT_PENDING_SQL, MAX_TEXT_CHARS, PENDING_SQL, TOUCH_SQL, UPSERT_SQL, contentHash, countPending, embedKind, parseEmbedArgs, textFor,
  type EmbedDb, type Kind,
} from "./embed-data";

const vec = (seed: number) => Array.from({ length: DIMENSIONS }, (_, i) => ((i + seed) % 7) / 10);

type Row = { id: string; first: string | null; second: string | null; stored_hash: string | null };

// A stateful fake of the embeddings table for one kind: PENDING returns the rows that have no stored hash, UPSERT stores one.
function fakeDb(rows: Row[], options: { failOnUpsert?: boolean } = {}) {
  const stored = new Map<string, string>(); // id -> hash
  for (const r of rows) if (r.stored_hash) stored.set(r.id, r.stored_hash);
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const db: EmbedDb = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (Object.values(PENDING_SQL).includes(text)) {
        const [, cursor, limit] = params as [string, string, number];
        const pending = rows.filter((r) => BigInt(r.id) > BigInt(cursor) && !stored.has(r.id)).slice(0, limit);
        return { rows: pending.map((r) => ({ ...r })) };
      }
      if (text === UPSERT_SQL) {
        if (options.failOnUpsert) throw new Error("db down");
        stored.set(String(params[1]), String(params[3]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { db, calls, stored };
}
const row = (id: number, first: string | null, second: string | null = null, stored_hash: string | null = null): Row => ({ id: String(id), first, second, stored_hash });
const fake = (texts: string[]) => texts.map((_, i) => vec(i));

test("the embedded text is the title and description on one line, cleaned and cut to size", () => {
  assert.equal(textFor("Fix login", "Users cannot\nsign in\t today"), "Fix login Users cannot sign in today");
  assert.equal(textFor("Only a title", null), "Only a title");
  assert.equal(textFor(null, null), "");
  assert.equal(textFor("a\u0000b\u0007c", "\u001f"), "a b c");
  assert.equal(textFor("x".repeat(MAX_TEXT_CHARS * 2), null).length, MAX_TEXT_CHARS);
  assert.equal(textFor(42 as unknown as string, { a: 1 }), "");
  assert.match(contentHash("abc"), /^[0-9a-f]{64}$/);
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});

test("pending-row queries page by id with bound parameters; only issues and pull requests are re-embedded after an edit", () => {
  for (const kind of ["issue", "commit", "pull_request"] as Kind[]) {
    assert.match(PENDING_SQL[kind], /e\.model = \$1/);
    assert.match(PENDING_SQL[kind], /\.id > \$2::bigint/);
    assert.match(PENDING_SQL[kind], /ORDER BY \w\.id LIMIT \$3$/);
    assert.doesNotMatch(PENDING_SQL[kind], /\$\{|password|email/i);
  }
  assert.match(PENDING_SQL.issue, /updated_at > e\.created_at/);
  assert.match(PENDING_SQL.pull_request, /updated_at > e\.created_at/);
  assert.doesNotMatch(PENDING_SQL.commit, /updated_at/); // commits never change
  assert.match(UPSERT_SQL, /ON CONFLICT \(entity_type, entity_id, model\) DO UPDATE/);
  assert.match(UPSERT_SQL, /\$5::vector/);
});

test("rows are embedded in batches and written with the model, the hash and the vector text; the text itself is never sent to the database", async () => {
  const { db, calls } = fakeDb([row(1, "Crash on login", "stack trace"), row(2, "Add dark mode", null), row(3, "Typo", "in the README")]);
  const batches: string[][] = [];
  const r = await embedKind(db, "issue", async (texts) => { batches.push(texts); return fake(texts); }, { limit: 10, batchSize: 2 });
  assert.deepEqual(r, { seen: 3, embedded: 3, unchanged: 0, empty: 0 });
  assert.deepEqual(batches.map((b) => b.length), [2, 1]);
  assert.equal(batches[0][0], "Crash on login stack trace");
  const upserts = calls.filter((c) => c.text === UPSERT_SQL);
  assert.equal(upserts.length, 3);
  assert.deepEqual(upserts[0].params.slice(0, 4), ["issue", "1", MODEL_NAME, contentHash("Crash on login stack trace")]);
  assert.match(String(upserts[0].params[4]), /^\[[\d.,]+\]$/);
  for (const c of calls) assert.ok(!c.params.some((p) => typeof p === "string" && p.includes("stack trace")), "the text is not sent back to the database");
  // paging: the cursor is the last id of the previous batch
  const pendingCalls = calls.filter((c) => c.text === PENDING_SQL.issue);
  assert.deepEqual(pendingCalls.slice(0, 2).map((c) => c.params[1]), ["0", "2"]);
});

test("a rerun does nothing: rows that already have an embedding are not read again", async () => {
  const { db, calls } = fakeDb([row(1, "a title"), row(2, "another title")]);
  let embedded = 0;
  const embedder = async (texts: string[]) => { embedded += texts.length; return fake(texts); };
  await embedKind(db, "pull_request", embedder, { limit: 100 });
  const second = await embedKind(db, "pull_request", embedder, { limit: 100 });
  assert.deepEqual(second, { seen: 0, embedded: 0, unchanged: 0, empty: 0 });
  assert.equal(embedded, 2);
  assert.equal(calls.filter((c) => c.text === UPSERT_SQL).length, 2);
});

test("an edited row whose embedded text did not change keeps its vector; empty rows are skipped", async () => {
  const text = "Same title same body";
  const { db, calls } = fakeDb([row(1, "Same title", "same body", contentHash(text)), row(2, "", null), row(3, "New", null)]);
  // row 1 is pending only because PENDING_SQL says it was edited; the fake returns it by hiding its stored state
  const pending = db.query.bind(db);
  db.query = async (t, p) => (t === PENDING_SQL.issue ? { rows: [row(1, "Same title", "same body", contentHash(text)), row(2, "", null), row(3, "New", null)] .filter((r) => BigInt(r.id) > BigInt(String(p?.[1]))) } : pending(t, p));
  let embedded: string[] = [];
  const r = await embedKind(db, "issue", async (texts) => { embedded = texts; return fake(texts); }, { limit: 3 });
  assert.deepEqual(r, { seen: 3, embedded: 1, unchanged: 1, empty: 1 });
  assert.deepEqual(embedded, ["New"]);
  assert.deepEqual(calls.find((c) => c.text === TOUCH_SQL)?.params, ["issue", "1", MODEL_NAME]);
});

test("the limit is respected", async () => {
  const { db } = fakeDb(Array.from({ length: 10 }, (_, i) => row(i + 1, `title ${i}`)));
  const r = await embedKind(db, "commit", async (t) => fake(t), { limit: 4, batchSize: 3 });
  assert.equal(r.seen, 4);
  assert.equal(r.embedded, 4);
  assert.equal(BATCH_SIZE, 32);
});

test("a bad embedder result is refused before anything is written: wrong count, wrong size, NaN", async () => {
  for (const bad of [
    async () => [vec(1)], // one vector for two texts
    async (t: string[]) => t.map(() => vec(1).slice(0, 10)), // wrong dimensions
    async (t: string[]) => t.map(() => [...vec(1).slice(1), NaN]), // not a number
  ]) {
    const { db, calls } = fakeDb([row(1, "one"), row(2, "two")]);
    await assert.rejects(embedKind(db, "issue", bad, { limit: 2 }));
    assert.equal(calls.filter((c) => c.text === UPSERT_SQL).length, 0);
  }
});

test("failures are raised, not hidden: an embedder error or a database error stops the run", async () => {
  const { db } = fakeDb([row(1, "one")]);
  await assert.rejects(embedKind(db, "issue", async () => { throw new Error("model failed"); }, { limit: 1 }), /model failed/);
  const failing = fakeDb([row(1, "one")], { failOnUpsert: true });
  await assert.rejects(embedKind(failing.db, "issue", async (t) => fake(t), { limit: 1 }), /db down/);
  assert.equal(failing.stored.size, 0);
});

test("hostile text is just text: it reaches the embedder, not the SQL", async () => {
  const evil = "'); DROP TABLE embeddings; --";
  const { db, calls } = fakeDb([row(1, evil, evil)]);
  const seen: string[] = [];
  await embedKind(db, "issue", async (t) => { seen.push(...t); return fake(t); }, { limit: 1 });
  assert.match(seen[0], /DROP TABLE/);
  for (const c of calls) assert.doesNotMatch(c.text, /DROP TABLE/);
});

test("counting pending rows uses the same rule as the pipeline", async () => {
  assert.match(COUNT_PENDING_SQL.issue, /e\.id IS NULL OR i\.updated_at > e\.created_at/);
  assert.equal(await countPending({ query: async () => ({ rows: [{ n: 7 }] }) }, "issue"), 7);
  assert.equal(await countPending({ query: async () => ({ rows: [] }) }, "commit"), 0);
});

test("command line: dry run by default, bounded limit, known kinds only", () => {
  assert.deepEqual(parseEmbedArgs([]), { apply: false, kinds: ["issue", "commit", "pull_request"], limit: 1000 });
  assert.deepEqual(parseEmbedArgs(["--apply", "--kind=issues", "--limit=50"]), { apply: true, kinds: ["issue"], limit: 50 });
  assert.deepEqual(parseEmbedArgs(["--kind=pull-requests"]).kinds, ["pull_request"]);
  for (const bad of ["--limit=0", "--limit=1000001", "--limit=x", "--kind=users", "--kind=constructor", "--kind=__proto__", "--force", "apply"]) {
    assert.throws(() => parseEmbedArgs([bad]), /Unsupported or invalid/, bad);
  }
});
