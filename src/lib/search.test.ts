import assert from "node:assert/strict";
import { test } from "node:test";
import { DIMENSIONS, MODEL_NAME } from "./embedding-model";
import {
  KEYWORD_SEARCH_SQL, MAX_QUERY_LENGTH, SEARCH_LIMIT, SEMANTIC_SEARCH_SQL, parseSearchQuery, searchKeyword, searchSemantic,
} from "./search";

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
  await searchKeyword("'; DROP TABLE issues; --", async (text, params) => { seen = { text, params }; return []; });
  assert.equal(seen!.text, KEYWORD_SEARCH_SQL);
  assert.deepEqual(seen!.params, ["'; DROP TABLE issues; --", SEARCH_LIMIT]);
});

test("semantic search orders by cosine distance, filters by model and drops embeddings whose row is gone", async () => {
  assert.match(SEMANTIC_SEARCH_SQL, /e\.embedding <=> \$1::vector AS distance/);
  assert.match(SEMANTIC_SEARCH_SQL, /WHERE e\.model = \$2::text ORDER BY e\.embedding <=> \$1::vector LIMIT \$3/); // the form the HNSW index serves
  assert.match(SEMANTIC_SEARCH_SQL, /WHERE coalesce\(i\.id, p\.id, c\.id\) IS NOT NULL/);
  assert.doesNotMatch(SEMANTIC_SEARCH_SQL, /\$\{|password|email|SELECT \*/i);
  let seen: readonly unknown[] = [];
  await searchSemantic(vec, async (_t, params) => { seen = params; return []; });
  assert.equal(seen[1], MODEL_NAME);
  assert.equal(seen[2], SEARCH_LIMIT);
  assert.match(String(seen[0]), /^\[[\d.,]+\]$/);
});

test("a query vector of the wrong size or with non-numbers never reaches the database", async () => {
  let called = false;
  const run = async () => { called = true; return []; };
  await assert.rejects(searchSemantic(vec.slice(1), run), RangeError);
  await assert.rejects(searchSemantic([...vec.slice(1), NaN], run), TypeError);
  assert.equal(called, false);
});
