import assert from "node:assert/strict";
import { test } from "node:test";
import * as contributions from "./contributions";
import { managerSql, participantSql } from "./project-access";
import {
  COMMIT_EVIDENCE_SQL, EVIDENCE_LIMIT, ISSUE_EVIDENCE_SQL, MEMBER_CONTRIBUTIONS_SQL, LIST_PROJECTS_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL,
  commitUrl, getMemberEvidence, listMemberContributions, listProjects,
} from "./contributions";

// The shape of a row from MEMBER_CONTRIBUTIONS_SQL: counts from contribution_counts(), score from score_from_counts().
const counts = { commits: 10, prs_opened: 4, prs_merged: 3, reviews_given: 2, issues_closed: 1, score: 33 };

test("counts and score come from the database's contribution_counts() and score_from_counts(), not from TypeScript", () => {
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /CROSS JOIN LATERAL contribution_counts\(u\.id, \$1::bigint\) c/);
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /score_from_counts\(c\.commits, c\.prs_merged, c\.reviews_given, c\.issues_closed\)/);
  // The counting rules are no longer written in this query.
  assert.doesNotMatch(MEMBER_CONTRIBUTIONS_SQL, /FROM commits|FROM pull_requests|FROM pr_reviews|FROM pr_issue_links/);
  assert.equal("contributionScore" in contributions || "SCORE_WEIGHTS" in contributions, false);
});

test("opened pull requests are counted but are not an input to the score", async () => {
  // prs_opened is selected for display, and score_from_counts() is given merged PRs, never opened ones.
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /c\.prs_opened::int AS prs_opened/);
  assert.doesNotMatch(MEMBER_CONTRIBUTIONS_SQL, /score_from_counts\([^)]*prs_opened/);
  // The score is whatever the database returned: changing the opened count does not change it.
  const run = (prs_opened: number) => (async () => [{ ...counts, prs_opened, user_id: "1", full_name: "A", role: "student" }]) as never;
  const few = await listMemberContributions("4", "77", run(1));
  const many = await listMemberContributions("4", "77", run(99));
  assert.equal(few[0].prs_opened, 1);
  assert.equal(many[0].prs_opened, 99);
  assert.equal(few[0].score, many[0].score);
});

test("numbers that PostgreSQL returns as strings reach the UI as numbers", async () => {
  const stringRow = { user_id: "1", full_name: "A", role: "student", commits: "10", prs_opened: "4", prs_merged: "3", reviews_given: "2", issues_closed: "1", score: "33.00" };
  const [m] = await listMemberContributions("4", "77", (async () => [stringRow]) as never);
  for (const k of ["commits", "prs_opened", "prs_merged", "reviews_given", "issues_closed", "score"] as const) assert.equal(typeof m[k], "number", k);
  assert.deepEqual([m.commits, m.prs_opened, m.prs_merged, m.reviews_given, m.issues_closed, m.score], [10, 4, 3, 2, 1, 33]);
  assert.equal(typeof m.user_id, "string");
  // The query casts BIGINT counts to int and the NUMERIC score to float8 so the driver returns numbers in the first place.
  for (const col of ["commits", "prs_opened", "prs_merged", "reviews_given", "issues_closed"]) assert.match(MEMBER_CONTRIBUTIONS_SQL, new RegExp(`c\\.${col}::int AS ${col}`));
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /\)::float8 AS score/);
});

test("queries select no emails or password hashes, never use SELECT *, and bind every value", () => {
  for (const sql of [MEMBER_CONTRIBUTIONS_SQL, COMMIT_EVIDENCE_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL]) {
    assert.doesNotMatch(sql, /password|email|SELECT\s+\*/i);
    assert.doesNotMatch(sql, /\$\{/); // placeholders only; no interpolated values
  }
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /\$2::bigint IS NULL OR u\.id = \$2::bigint/);
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /FROM teams t JOIN team_members tm ON tm\.team_id = t\.id WHERE t\.project_id = \$1::bigint/);
});

test("each evidence query uses the same conditions as its count (defined in contribution_counts()), scoped to the project", () => {
  assert.match(COMMIT_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND c\.author_id = \$2::bigint/);
  assert.match(PULL_REQUEST_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND p\.author_id = \$2::bigint/);
  assert.match(REVIEW_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND rv\.reviewer_id = \$2::bigint/);
  assert.match(ISSUE_EVIDENCE_SQL, /p\.author_id = \$2::bigint AND p\.status = 'merged' AND i\.status = 'closed'/);
  for (const sql of [COMMIT_EVIDENCE_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL, ISSUE_EVIDENCE_SQL]) assert.match(sql, /LIMIT \$3$/);
});

test("members are listed highest score first, ties by name", async () => {
  const row = (user_id: string, full_name: string, score: number) => ({ ...counts, score, user_id, full_name, role: "student" });
  const list = await listMemberContributions("4", "77", async (_t, p) => {
    assert.deepEqual(p, ["4", null, "77"]); // project, no single-user filter, the viewer
    return [row("1", "Zed", 5), row("2", "Amy", 5), row("3", "Bob", 50)];
  });
  assert.deepEqual(list.map((m) => m.full_name), ["Bob", "Amy", "Zed"]);
  assert.equal(list[0].score, 50);
});

test("member evidence passes project, user and limit as parameters; a non-member gives null", async () => {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const run = (async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    return text === MEMBER_CONTRIBUTIONS_SQL ? [{ ...counts, user_id: "9", full_name: "A", role: "lead" }] : [];
  }) as never;
  const ev = await getMemberEvidence("4", "9", "77", run);
  assert.equal(ev?.member.score, 33);
  assert.deepEqual(calls[0].params, ["4", "9", "77"]); // project, member, viewer
  assert.equal(calls.length, 5);
  for (const c of calls.slice(1)) assert.deepEqual(c.params, ["4", "9", EVIDENCE_LIMIT]);
  assert.equal(await getMemberEvidence("4", "9", "77", (async () => []) as never), null);
});

test("commit links are built only for plain https GitHub repository addresses and hex shas", () => {
  const sha = "a".repeat(40);
  assert.equal(commitUrl("https://github.com/o/r", sha), `https://github.com/o/r/commit/${sha}`);
  assert.equal(commitUrl("https://github.com/o/r.git/", sha), `https://github.com/o/r/commit/${sha}`);
  for (const bad of [null, "", "http://github.com/o/r", "https://evil.example/o/r", "https://github.com/o", "javascript:alert(1)", "https://github.com/o/r/x"]) {
    assert.equal(commitUrl(bad, sha), null);
  }
  assert.equal(commitUrl("https://github.com/o/r", "not-a-sha"), null);
});

// ---- who may see what

test("the member query uses the shared P1-07 policy: managers (mentor or any team lead of the project) see everyone, a member sees themselves", () => {
  // The visibility rule is the shared managerSql fragment, bound to the project's member rows and to the viewer ($3).
  assert.ok(MEMBER_CONTRIBUTIONS_SQL.includes(`(${managerSql("$3", "m.project_id")} OR u.id = $3::bigint)`));
  // Not the old rule: a lead is no longer limited to the members of their own team.
  assert.doesNotMatch(MEMBER_CONTRIBUTIONS_SQL, /vtm\.user_id = u\.id|vt\.lead_id/);
  assert.doesNotMatch(MEMBER_CONTRIBUTIONS_SQL, /\$3::bigint IS NULL|OR TRUE|1 = 1/); // there is no "no viewer" bypass
});

test("access stays scoped to the requested project: the member rows come from $1 only, and the manager check uses that same project", () => {
  // The manager test reads m.project_id, and m is built only from teams of $1, so being a manager elsewhere gives nothing here.
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /FROM \(SELECT DISTINCT tm\.user_id, t\.project_id FROM teams t JOIN team_members tm ON tm\.team_id = t\.id WHERE t\.project_id = \$1::bigint\) m/);
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /contribution_counts\(u\.id, \$1::bigint\)/);
  assert.equal([...MEMBER_CONTRIBUTIONS_SQL.matchAll(/project_id = /g)].length >= 1 && !/\$[4-9]/.test(MEMBER_CONTRIBUTIONS_SQL), true);
});

test("the project list is the shared participant rule: mentor, team lead or team member of the project", async () => {
  assert.equal(LIST_PROJECTS_SQL, `SELECT p.id::text AS id, p.name FROM projects p WHERE ${participantSql("$1", "p.id")} ORDER BY p.name, p.id`);
  let seen: readonly unknown[] = [];
  await listProjects("5", async (t, p) => { assert.equal(t, LIST_PROJECTS_SQL); seen = p; return []; });
  assert.deepEqual(seen, ["5"]);
});

test("evidence follows the same visibility rule: it is only read after the member query returned a row for this viewer", async () => {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const hidden = (async (text: string, params: readonly unknown[]) => { calls.push({ text, params }); return []; }) as never;
  // A member the viewer may not see (or an outsider's request): the member query is the only query that runs.
  assert.equal(await getMemberEvidence("4", "9", "78", hidden), null);
  assert.deepEqual(calls.map((c) => c.text), [MEMBER_CONTRIBUTIONS_SQL]);
  assert.deepEqual(calls[0].params, ["4", "9", "78"]); // project, member, then the viewer
  // A visible member: the evidence queries run for exactly that project and user, and the viewer is not passed on.
  calls.length = 0;
  const visible = (async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    return text === MEMBER_CONTRIBUTIONS_SQL ? [{ ...counts, user_id: "9", full_name: "A", role: "student" }] : [];
  }) as never;
  assert.notEqual(await getMemberEvidence("4", "9", "78", visible), null);
  assert.equal(calls.length, 5);
  for (const c of calls.slice(1)) assert.deepEqual(c.params, ["4", "9", EVIDENCE_LIMIT]);
  for (const sql of [COMMIT_EVIDENCE_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL, ISSUE_EVIDENCE_SQL]) assert.match(sql, /r\.project_id = \$1::bigint/); // project isolation
});

test("the viewer is a required argument of every contribution read, so a caller cannot forget it", async () => {
  let n = 0;
  const run = (async () => { n++; return []; }) as never;
  await listMemberContributions("4", "5", run);
  await getMemberEvidence("4", "9", "5", run);
  await listProjects("5", run);
  assert.equal(n, 3);
  assert.equal(listMemberContributions.length >= 2 && getMemberEvidence.length >= 3 && listProjects.length >= 1, true);
});
