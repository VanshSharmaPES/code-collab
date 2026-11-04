import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATE_ISSUE_SQL, GET_ISSUE_SQL, LIST_ISSUES_SQL, LIST_REPOSITORIES_SQL, LIST_WRITABLE_REPOSITORIES_SQL, MIRRORED_READ_ONLY_MESSAGE, MirroredIssueError, PAGE_SIZE,
  RepositoryNotFoundError, UPDATE_ISSUE_SQL, canEditIssue, countIssues, createIssue, listIssues, listWritableRepositories, updateIssue,
} from "./issues";
import { participantSql } from "./project-access";

const input = { title: "t", body: null, status: "closed", priority: "low" } as const;

test("no query selects user emails or password hashes, or uses SELECT *", () => {
  for (const sql of [LIST_ISSUES_SQL, GET_ISSUE_SQL]) {
    assert.doesNotMatch(sql, /password|email|\*/i);
  }
});

test("filters and paging are bound parameters", async () => {
  let seen: readonly unknown[] = [];
  await listIssues({ repositoryId: "4", status: "open" }, 3, "77", async (_t, p) => { seen = p; return []; });
  assert.deepEqual(seen, ["4", "open", PAGE_SIZE, 2 * PAGE_SIZE, "77"]); // the last one is the viewer
  assert.equal(await countIssues({ repositoryId: null, status: null }, "77", async () => [{ n: 7 }]), 7);
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
  await assert.rejects(createIssue("4", input, "9", async () => { throw Object.assign(new Error("fk"), { code: "23503", constraint: "issues_repository_id_fkey" }); }), RepositoryNotFoundError);
  await assert.rejects(createIssue("4", input, "9", async () => { throw new Error("boom"); }), /boom/);
});

test("update keeps the closed/closed_at rule, moves updated_at forward, and reports a missing issue", async () => {
  assert.match(UPDATE_ISSUE_SQL, /updated_at = now\(\)/);
  assert.match(UPDATE_ISSUE_SQL, /CASE WHEN \$4::text = 'closed' THEN COALESCE\(i\.closed_at, now\(\)\) ELSE NULL END/);
  assert.match(UPDATE_ISSUE_SQL, /WHERE i\.id = \$1::bigint/);
  let seen: readonly unknown[] = [];
  assert.equal(await updateIssue("5", input, "9", async (_t, p) => { seen = p; return [{ id: "5" }]; }), true);
  assert.deepEqual(seen, ["5", "t", null, "closed", "low", "9"]);
  assert.equal(await updateIssue("5", input, "9", async () => []), false);
});

test("issue writes are single statements that do not depend on an outbox table", () => {
  for (const sql of [CREATE_ISSUE_SQL, UPDATE_ISSUE_SQL]) {
    assert.doesNotMatch(sql, /outbox/i);
    assert.match(sql, /^WITH (ins|upd) AS \(/);
    assert.equal(sql.split(";").length, 1);
  }
  assert.match(CREATE_ISSUE_SQL, /^WITH ins AS \(INSERT INTO issues /);
  assert.match(UPDATE_ISSUE_SQL, /^WITH upd AS \(UPDATE issues i /);
  // The audit actor is set in the same statement, transaction-locally (is_local = true), from parameter 6.
  assert.match(UPDATE_ISSUE_SQL, /set_config\('codecollab\.actor_id', \$6::text, true\)/);
});

test("only the repository foreign key reads as a missing repository; other foreign keys keep their own error", async () => {
  const authorFk = Object.assign(new Error("author"), { code: "23503", constraint: "issues_author_id_fkey" });
  await assert.rejects(createIssue("4", input, "9", async () => { throw authorFk; }), (err) => err === authorFk && !(err instanceof RepositoryNotFoundError));
  const unnamed = Object.assign(new Error("no constraint"), { code: "23503" });
  await assert.rejects(createIssue("4", input, "9", async () => { throw unnamed; }), (err) => err === unnamed);
});

test("create: no inserted row is reported as a missing repository, or as read-only when it mirrors GitHub", async () => {
  await assert.rejects(createIssue("4", input, "9", async () => [{ id: null, mirrored: null }]), RepositoryNotFoundError);
  await assert.rejects(createIssue("4", input, "9", async () => [{ id: null, mirrored: false }]), RepositoryNotFoundError);
  await assert.rejects(createIssue("4", input, "9", async () => []), RepositoryNotFoundError);
  await assert.rejects(createIssue("4", input, "9", async () => [{ id: null, mirrored: true }]), (err) => err instanceof MirroredIssueError && err.message === MIRRORED_READ_ONLY_MESSAGE);
  assert.equal(await createIssue("4", input, "9", async () => [{ id: "8", mirrored: false }]), "8");
});

test("create only inserts into an existing repository without a github_url, and still numbers per repository", () => {
  // ...and only if the author ($6, the signed-in user) takes part in the repository's project: otherwise the repository "does not exist".
  const taking = participantSql("$6", "repositories.project_id");
  assert.ok(CREATE_ISSUE_SQL.includes(`HAVING EXISTS (SELECT 1 FROM repositories WHERE id = $1::bigint AND github_url IS NULL AND ${taking}) RETURNING id)`));
  assert.match(CREATE_ISSUE_SQL, /FROM issues WHERE repository_id = \$1::bigint HAVING/);
  assert.ok(CREATE_ISSUE_SQL.endsWith(`(SELECT github_url IS NOT NULL FROM repositories WHERE id = $1::bigint AND ${taking}) AS mirrored`));
});

test("update only touches issues whose repository has no github_url, and keeps the audit actor", async () => {
  const taking = participantSql("$6", "r.project_id"); // the actor ($6) must take part in the issue's project
  assert.ok(UPDATE_ISSUE_SQL.includes(`FROM (SELECT set_config('codecollab.actor_id', $6::text, true)) AS actor WHERE i.id = $1::bigint AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = i.repository_id AND r.github_url IS NULL AND ${taking}) RETURNING i.id)`));
  assert.ok(UPDATE_ISSUE_SQL.includes(`r.github_url IS NOT NULL AND ${taking}) AS mirrored`)); // a mirror outside the actor's projects is not revealed
  let seen: readonly unknown[] = [];
  await updateIssue("5", input, "9", async (_t, p) => { seen = p; return [{ id: "5", mirrored: false }]; });
  assert.equal(seen[5], "9"); // parameter 6 is the actor
  assert.equal(seen.length, 6);
  assert.equal(await updateIssue("5", input, "9", async () => [{ id: "5", mirrored: false }]), true);
  assert.equal(await updateIssue("5", input, "9", async () => [{ id: null, mirrored: false }]), false); // missing issue
  await assert.rejects(updateIssue("5", input, "9", async () => [{ id: null, mirrored: true }]), (err) => err instanceof MirroredIssueError && err.message === MIRRORED_READ_ONLY_MESSAGE);
});

test("the New Issue dropdown lists only repositories without a github_url; the filter still lists all", async () => {
  assert.match(LIST_WRITABLE_REPOSITORIES_SQL, /WHERE r\.github_url IS NULL/);
  assert.doesNotMatch(LIST_REPOSITORIES_SQL, /github_url/);
  let seenSql = "";
  await listWritableRepositories("77", async (text) => { seenSql = text; return []; });
  assert.equal(seenSql, LIST_WRITABLE_REPOSITORIES_SQL);
});

test("the Edit link is shown only for issues in repositories that do not mirror GitHub", () => {
  assert.equal(canEditIssue({ is_mirrored: false }), true);
  assert.equal(canEditIssue({ is_mirrored: true }), false);
  assert.match(GET_ISSUE_SQL, /\(r\.github_url IS NOT NULL\) AS is_mirrored/);
  assert.match(LIST_ISSUES_SQL, /\(r\.github_url IS NOT NULL\) AS is_mirrored/);
});
