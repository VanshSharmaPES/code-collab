import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATE_ISSUE_SQL, GET_ISSUE_SQL, LIST_ISSUES_SQL, PAGE_SIZE, RepositoryNotFoundError, UPDATE_ISSUE_SQL, countIssues, createIssue, listIssues, updateIssue,
} from "./issues";

const input = { title: "t", body: null, status: "closed", priority: "low" } as const;

test("no query selects user emails or password hashes, or uses SELECT *", () => {
  for (const sql of [LIST_ISSUES_SQL, GET_ISSUE_SQL]) {
    assert.doesNotMatch(sql, /password|email|\*/i);
  }
});

test("filters and paging are bound parameters", async () => {
  let seen: readonly unknown[] = [];
  await listIssues({ repositoryId: "4", status: "open" }, 3, async (_t, p) => { seen = p; return []; });
  assert.deepEqual(seen, ["4", "open", PAGE_SIZE, 2 * PAGE_SIZE]);
  assert.equal(await countIssues({ repositoryId: null, status: null }, async () => [{ n: 7 }]), 7);
});

test("create: the number comes from the database, closed issues get closed_at, the author is a parameter", async () => {
  assert.match(CREATE_ISSUE_SQL, /COALESCE\(MAX\(number\), 0\) \+ 1/);
  assert.match(CREATE_ISSUE_SQL, /CASE WHEN \$4::text = 'closed' THEN now\(\) END/);
  let seen: readonly unknown[] = [];
  const id = await createIssue("4", input, "9", async (_t, p) => { seen = p; return [{ id: "55" }]; });
  assert.equal(id, "55");
  assert.deepEqual(seen, ["4", "t", null, "closed", "low", "9"]);
});

test("create retries a duplicate issue number, gives up after five tries, and maps a missing repository", async () => {
  let calls = 0;
  const dup = Object.assign(new Error("dup"), { code: "23505" });
  assert.equal(await createIssue("4", input, "9", async () => { if (++calls < 3) throw dup; return [{ id: "1" }]; }), "1");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(createIssue("4", input, "9", async () => { calls++; throw dup; }), /dup/);
  assert.equal(calls, 5);
  await assert.rejects(createIssue("4", input, "9", async () => { throw Object.assign(new Error("fk"), { code: "23503" }); }), RepositoryNotFoundError);
  await assert.rejects(createIssue("4", input, "9", async () => { throw new Error("boom"); }), /boom/);
});

test("update keeps the closed/closed_at rule, moves updated_at forward, and reports a missing issue", async () => {
  assert.match(UPDATE_ISSUE_SQL, /updated_at = now\(\)/);
  assert.match(UPDATE_ISSUE_SQL, /CASE WHEN \$4::text = 'closed' THEN COALESCE\(i\.closed_at, now\(\)\) ELSE NULL END/);
  assert.match(UPDATE_ISSUE_SQL, /WHERE id = \$1::bigint/);
  let seen: readonly unknown[] = [];
  assert.equal(await updateIssue("5", input, "9", async (_t, p) => { seen = p; return [{ id: "5" }]; }), true);
  assert.deepEqual(seen, ["5", "t", null, "closed", "low"]);
  assert.equal(await updateIssue("5", input, "9", async () => []), false);
});

test("issue writes are plain single statements that do not depend on an outbox table", () => {
  for (const sql of [CREATE_ISSUE_SQL, UPDATE_ISSUE_SQL]) {
    assert.doesNotMatch(sql, /outbox/i);
    assert.match(sql, /RETURNING (i\.)?id::text AS id$/);
  }
  assert.match(CREATE_ISSUE_SQL, /^INSERT INTO issues /);
  assert.match(UPDATE_ISSUE_SQL, /^UPDATE issues i /);
  assert.doesNotMatch(UPDATE_ISSUE_SQL, /\$6/); // five parameters: id, title, body, status, priority
});
