import assert from "node:assert/strict";
import { test } from "node:test";
import { DIMENSIONS, MODEL_NAME } from "./embedding-model";
import {
  KEYWORD_SEARCH_SQL, MAX_QUERY_LENGTH, SEARCH_LIMIT, SEMANTIC_SEARCH_SQL, ITERATIVE_SCAN_SQL, parseSearchQuery, searchKeyword, searchSemantic, type SemanticTx,
} from "./search";

// A transaction stand-in: runs the steps on the given query function.
const txOn = (run: (text: string, params: readonly unknown[]) => Promise<never[]>): SemanticTx => (fn) => fn(run);

const vec = Array.from({ length: DIMENSIONS }, (_, i) => i / 1000);

test("the search text must be one string of 2 to 200 characters; control characters and runs of spaces are cleaned", () => {
  assert.equal(parseSearchQuery("  login   error \n"), "login error");
  assert.equal(parseSearchQuery("a\u0000b"), "a b");
  for (const bad of [undefined, null, 42, ["a b"], {}, "", " ", "a", "x".repeat(MAX_QUERY_LENGTH + 1)]) assert.equal(parseSearchQuery(bad), null, String(bad));
  assert.equal(parseSearchQuery("x".repeat(MAX_QUERY_LENGTH))?.length, MAX_QUERY_LENGTH);
});

test("keyword search is PostgreSQL full-text search with the text as a bound parameter", async () => {
  assert.match(KEYWORD_SEARCH_SQL, /websearch_to_tsquery\('english', \$1::text\)/);
  assert.match(KEYWORD_SEARCH_SQL, /LIMIT \$2$/);
  for (const part of ["FROM issues i", "FROM pull_requests p", "FROM commits c"]) assert.ok(KEYWORD_SEARCH_SQL.includes(part), part);
  assert.doesNotMatch(KEYWORD_SEARCH_SQL, /password|email|\$\{|SELECT \*/i);
  let seen: { text: string; params: readonly unknown[] } | null = null;
  await searchKeyword("'; DROP TABLE issues; --", "42", async (text, params) => { seen = { text, params }; return []; });
  assert.equal(seen!.text, KEYWORD_SEARCH_SQL);
  assert.deepEqual(seen!.params, ["'; DROP TABLE issues; --", SEARCH_LIMIT, "42"]);
});

test("semantic search orders by cosine distance, filters by model and drops embeddings whose row is gone", async () => {
  assert.match(SEMANTIC_SEARCH_SQL, /e\.embedding <=> \$1::vector AS distance/);
  assert.match(SEMANTIC_SEARCH_SQL, /ORDER BY e\.embedding <=> \$1::vector LIMIT \$3\) SELECT/);
  assert.match(SEMANTIC_SEARCH_SQL, /WHERE coalesce\(i\.id, p\.id, c\.id\) IS NOT NULL/);
  assert.doesNotMatch(SEMANTIC_SEARCH_SQL, /\$\{|password|email|SELECT \*/i);
  let seen: readonly unknown[] = [];
  await searchSemantic(vec, "42", txOn(async (t, params) => { if (t === SEMANTIC_SEARCH_SQL) seen = params; return []; }));
  assert.equal(seen[1], MODEL_NAME);
  assert.equal(seen[2], SEARCH_LIMIT);
  assert.equal(seen[3], "42");
  assert.match(String(seen[0]), /^\[[\d.,]+\]$/);
});

test("a query vector of the wrong size or with non-numbers never reaches the database", async () => {
  let called = false;
  const run = txOn(async () => { called = true; return []; });
  await assert.rejects(searchSemantic(vec.slice(1), "42", run), RangeError);
  await assert.rejects(searchSemantic([...vec.slice(1), NaN], "42", run), TypeError);
  assert.equal(called, false);
});

test("search only returns rows of projects the viewer takes part in: every branch of both queries is checked against the viewer parameter", () => {
  // Keyword: the issue, pull request and commit branches each carry the participant check on the viewer ($3).
  assert.equal(KEYWORD_SEARCH_SQL.match(/px\.mentor_id = \$3::bigint/g)?.length, 3);
  for (const col of ["r.project_id"]) assert.ok(KEYWORD_SEARCH_SQL.includes(`px.id = ${col}`));
  // Semantic: the check is on the viewer ($4), inside the nearest-vector query and before its LIMIT, for all three kinds.
  const [inner] = SEMANTIC_SEARCH_SQL.split("LIMIT $3");
  assert.equal(inner.match(/px\.mentor_id = \$4::bigint/g)?.length, 3);
  for (const kind of ["issue", "pull_request", "commit"]) assert.ok(inner.includes(`e.entity_type = '${kind}' AND EXISTS`), kind);
  assert.doesNotMatch(SEMANTIC_SEARCH_SQL, /\$[56]/);
  assert.doesNotMatch(KEYWORD_SEARCH_SQL, /\$[4-9]/);
});

test("the semantic query runs after SET LOCAL hnsw.iterative_scan, in the same transaction, so a viewer with a small share still gets a full list", async () => {
  assert.equal(ITERATIVE_SCAN_SQL, "SET LOCAL hnsw.iterative_scan = 'strict_order'"); // strict_order keeps the distance order exact
  const statements: string[] = [];
  await searchSemantic(vec, "42", txOn(async (text) => { statements.push(text); return []; }));
  assert.deepEqual(statements, [ITERATIVE_SCAN_SQL, SEMANTIC_SEARCH_SQL]);
  const failed = searchSemantic(vec, "42", txOn(async (text) => { if (text === ITERATIVE_SCAN_SQL) throw new Error("unrecognized configuration parameter"); return []; }));
  await assert.rejects(failed, /unrecognized configuration parameter/, "an older pgvector fails loudly instead of returning a short list");
});
