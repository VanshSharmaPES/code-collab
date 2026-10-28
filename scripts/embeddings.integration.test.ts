// Integration test against a REAL PostgreSQL with pgvector. Skipped unless TEST_PG_ADMIN_URL is set, so `npm test` needs no server:
//   TEST_PG_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5433/postgres npm test
// Safety: the URL must be a local server; the test creates its own database (cc_embed_test_*), applies the schema there and
// drops only that database. It never touches the "codecollab" database. The embedding model is a deterministic stand-in
// (a hashed bag of words), so this checks the database side: pgvector, the HNSW index, SQL, paging and idempotency.
// Set TEST_REAL_MODEL=1 as well to also run the real sentence-transformer (downloads about 25 MB the first time).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { DIMENSIONS, MODEL_NAME, type Embedder } from "../src/lib/embedding-model";
import { KEYWORD_SEARCH_SQL, SEMANTIC_SEARCH_SQL, searchKeyword, searchSemantic, type SearchHit } from "../src/lib/search";
import { PENDING_SQL, countPending, embedKind } from "./embed-data";

const adminUrl = process.env.TEST_PG_ADMIN_URL;
if (adminUrl) {
  const u = new URL(adminUrl);
  assert.ok(["postgres:", "postgresql:"].includes(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname), "TEST_PG_ADMIN_URL must be a local PostgreSQL server");
  assert.notEqual(decodeURIComponent(u.pathname.slice(1)), "codecollab", "point the admin URL at the postgres maintenance database, not codecollab");
}

// A hashed bag of words, normalised: texts sharing words are close, texts sharing none are far.
const fakeEmbedder: Embedder = async (texts) => texts.map((t) => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 100003;
    v[h % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
});

describe("embeddings against a real PostgreSQL with pgvector", { skip: adminUrl ? false : "set TEST_PG_ADMIN_URL to a local PostgreSQL to run" }, () => {
  const dbName = `cc_embed_test_${randomBytes(6).toString("hex")}`;
  let admin: Client;
  let db: Client;
  const rows = <T,>(text: string, params: readonly unknown[]) => db.query(text, [...params]).then((r) => r.rows as T[]);
  const apply = (file: string) => db.query(readFileSync(join(process.cwd(), "db/schema", file), "utf8"));

  before(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(adminUrl as string); u.pathname = `/${dbName}`;
    db = new Client({ connectionString: u.toString() });
    await db.connect();
    for (const f of ["01_core.sql", "02_rest.sql", "08_embeddings.sql"]) await apply(f);
    await db.query(`
      INSERT INTO projects (name) VALUES ('p');
      INSERT INTO repositories (project_id, name) VALUES (1, 'repo-a');
      INSERT INTO issues (repository_id, number, title, body) VALUES
        (1, 1, 'Login crashes when the session cookie is missing', 'The app throws an error on sign in'),
        (1, 2, 'Add dark mode to the settings page', 'Users want a dark theme'),
        (1, 3, 'Improve the README formatting', NULL);
      INSERT INTO pull_requests (repository_id, number, title, description) VALUES
        (1, 4, 'Fix cookie parsing crash on login', 'Handles a missing cookie header'),
        (1, 5, 'Refactor database pool', 'Smaller connection pool');
      INSERT INTO commits (repository_id, sha, message, committed_at) VALUES
        (1, 'aaaaaaa', E'Update dark theme colours\\n\\nTweak the palette', now()),
        (1, 'bbbbbbb', 'Bump dependencies', now())`);
  });
  after(async () => {
    await db?.end();
    if (admin) {
      assert.match(dbName, /^cc_embed_test_[0-9a-f]{12}$/);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); // only the database this test created
      await admin.end();
    }
  });

  it("the migration is repeatable, enables pgvector, and builds an HNSW index with cosine distance", async () => {
    await apply("08_embeddings.sql"); // second run
    const [ext] = await rows<{ n: number }>("select count(*)::int n from pg_extension where extname = 'vector'", []);
    assert.equal(ext.n, 1);
    const [idx] = await rows<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'idx_embeddings_hnsw'", []);
    assert.match(idx.indexdef, /USING hnsw \(embedding vector_cosine_ops\)/);
  });

  it("the table refuses a vector of the wrong size and a duplicate (type, id, model)", async () => {
    await assert.rejects(db.query("insert into embeddings (entity_type, entity_id, model, content_hash, embedding) values ('issue', 99, 'm', 'h', '[1,2,3]')"), /dimensions/);
    await assert.rejects(db.query("insert into embeddings (entity_type, entity_id, model, content_hash, embedding) values ('user', 1, 'm', 'h', array_fill(0, ARRAY[384])::vector)"), /check/i);
  });

  it("the pipeline embeds issues, pull requests and commits, and a rerun adds nothing", async () => {
    for (const kind of ["issue", "pull_request", "commit"] as const) {
      assert.ok((await countPending(db, kind)) > 0);
      await embedKind(db, kind, fakeEmbedder, { limit: 100, batchSize: 2 }); // batches of 2 exercise the paging
      assert.equal(await countPending(db, kind), 0);
    }
    const [n] = await rows<{ n: number }>("select count(*)::int n from embeddings", []);
    assert.equal(n.n, 7);
    const again = await embedKind(db, "issue", fakeEmbedder, { limit: 100 });
    assert.deepEqual(again, { seen: 0, embedded: 0, unchanged: 0, empty: 0 });
    assert.equal((await rows<{ n: number }>("select count(*)::int n from embeddings", []))[0].n, 7);
    for (const sql of Object.values(PENDING_SQL)) await db.query(sql, [MODEL_NAME, "0", 1]); // the pending queries are valid SQL
  });

  const semantic = async (q: string): Promise<SearchHit[]> => searchSemantic((await fakeEmbedder([q]))[0], rows);

  it("semantic search returns the nearest rows across all three kinds, joined to their real titles", async () => {
    const hits = await semantic("login crash missing cookie");
    assert.equal(hits.length, 7);
    // The issue and the pull request about the same crash are the two nearest, whichever of them ranks first.
    assert.deepEqual(hits.slice(0, 2).map((h) => `${h.kind}: ${h.title}`).sort(), [
      "issue: Login crashes when the session cookie is missing",
      "pull_request: Fix cookie parsing crash on login",
    ]);
    assert.ok(hits[0].score > hits[1].score && hits[1].score > hits[6].score, "scores fall as the distance grows");
    assert.ok(hits[0].score <= 1 && hits[0].score > 0.3);
    const dark = await semantic("dark theme colours");
    assert.equal(dark[0].kind === "issue" || dark[0].kind === "commit", true);
    assert.ok(dark.some((h) => h.kind === "commit" && h.title === "Update dark theme colours")); // commit title is the first line only
    assert.equal(hits[0].repository_name, "repo-a");
  });

  it("an embedding whose row was deleted is never shown", async () => {
    await db.query("delete from issues where number = 2");
    const hits = await semantic("dark mode settings");
    assert.ok(!hits.some((h) => h.title === "Add dark mode to the settings page"));
    assert.equal(hits.length, 6);
  });

  it("an edit that changes the text is embedded again; an edit that does not change it keeps the vector", async () => {
    const hash = async () => (await rows<{ content_hash: string; created_at: Date }>("select content_hash, created_at from embeddings where entity_type = 'issue' and entity_id = (select id from issues where number = 3)", []))[0];
    const before = await hash();
    await db.query("update issues set status = 'in_progress', updated_at = now() where number = 3"); // not text
    assert.equal(await countPending(db, "issue"), 1);
    let calls = 0;
    const counting: Embedder = async (t) => { calls += t.length; return fakeEmbedder(t); };
    assert.deepEqual(await embedKind(db, "issue", counting, { limit: 10 }), { seen: 1, embedded: 0, unchanged: 1, empty: 0 });
    assert.equal(calls, 0);
    assert.equal((await hash()).content_hash, before.content_hash);
    await db.query("update issues set title = 'Rewrite the contributing guide', updated_at = now() where number = 3");
    assert.equal((await embedKind(db, "issue", counting, { limit: 10 })).embedded, 1);
    assert.notEqual((await hash()).content_hash, before.content_hash);
    assert.equal(await countPending(db, "issue"), 0);
  });

  it("keyword search finds rows by their words and survives hostile or malformed text", async () => {
    const hits = await searchKeyword("cookie crash", rows);
    assert.deepEqual(hits.map((h) => h.kind).sort(), ["issue", "pull_request"]);
    assert.ok(hits[0].score > 0);
    assert.deepEqual((await searchKeyword("dark theme", rows)).map((h) => h.kind).sort(), ["commit"]);
    for (const hostile of ["'; DROP TABLE issues; --", '"unbalanced quote', "a & | ! ( ) :*", "\\", "-- /* */", "OR OR AND NOT", "x".repeat(200)]) {
      await assert.doesNotReject(searchKeyword(hostile, rows), hostile);
    }
    assert.equal((await rows<{ n: number }>("select count(*)::int n from issues", []))[0].n, 2); // the table is still there
    assert.ok(KEYWORD_SEARCH_SQL.length > 0 && SEMANTIC_SEARCH_SQL.length > 0);
  });

  it("a second model's vectors are kept apart from the first", async () => {
    await db.query("insert into embeddings (entity_type, entity_id, model, content_hash, embedding) select entity_type, entity_id, 'other-model', content_hash, embedding from embeddings where entity_type = 'commit'");
    const hits = await semantic("dark theme colours");
    assert.equal(new Set(hits.map((h) => `${h.kind}-${h.id}`)).size, hits.length, "no row appears twice");
  });

  it("with the real sentence-transformer, a paraphrase finds the right issue (TEST_REAL_MODEL=1)", { skip: process.env.TEST_REAL_MODEL === "1" ? false : "set TEST_REAL_MODEL=1 to run the real model" }, async () => {
    const { embedTexts } = await import("../src/lib/embedder");
    await db.query("delete from embeddings");
    for (const kind of ["issue", "pull_request", "commit"] as const) await embedKind(db, kind, embedTexts, { limit: 100 });
    const hits = await searchSemantic((await embedTexts(["the application errors out when someone signs in without a cookie"]))[0], rows);
    assert.equal(hits[0].title, "Login crashes when the session cookie is missing"); // no word in common except "cookie"
  });

  it("on a table of realistic size the planner uses the HNSW index for the semantic query", async () => {
    // With 7 rows a sort is cheaper than any index, so the table is filled with 5,000 random vectors first.
    await db.query("delete from embeddings");
    await db.query(`insert into embeddings (entity_type, entity_id, model, content_hash, embedding)
      select 'issue', g, $1::text, 'h', (select array_agg(random() - 0.5) from generate_series(1, 384) where g is not null)::vector from generate_series(1, 5000) g`, [MODEL_NAME]);
    await db.query("analyze embeddings");
    const vector = `[${Array.from({ length: DIMENSIONS }, (_, i) => (i % 5) / 10).join(",")}]`;
    const plan = (await db.query("explain select e.entity_id from embeddings e where e.model = $1::text order by e.embedding <=> $2::vector limit 10", [MODEL_NAME, vector])).rows
      .map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(plan, /Index Scan using idx_embeddings_hnsw/);
    assert.equal((await rows(SEMANTIC_SEARCH_SQL, [vector, MODEL_NAME, 10])).length, 0, "random filler rows have no matching issue, so they are dropped");
  });
});
