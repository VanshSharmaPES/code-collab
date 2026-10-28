import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMIT_EVIDENCE_SQL, EVIDENCE_LIMIT, ISSUE_EVIDENCE_SQL, MEMBER_CONTRIBUTIONS_SQL, LIST_PROJECTS_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL,
  commitUrl, contributionScore, getMemberEvidence, listMemberContributions, listProjects,
} from "./contributions";

const counts = { commits: 10, prs_opened: 4, prs_merged: 3, reviews_given: 2, issues_closed: 1 };

test("the score uses the P1-12 weights: commit 1, merged PR 5, review 3, closed issue 2; opened PRs score nothing", () => {
  assert.equal(contributionScore(counts), 10 + 15 + 6 + 2);
  assert.equal(contributionScore({ ...counts, prs_opened: 99 }), 33);
  assert.equal(contributionScore({ commits: 0, prs_opened: 0, prs_merged: 0, reviews_given: 0, issues_closed: 0 }), 0);
});

test("queries select no emails or password hashes, never use SELECT *, and bind every value", () => {
  for (const sql of [MEMBER_CONTRIBUTIONS_SQL, COMMIT_EVIDENCE_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL]) {
    assert.doesNotMatch(sql, /password|email|SELECT\s+\*/i);
    assert.doesNotMatch(sql, /\$\{/); // placeholders only; no interpolated values
  }
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /\$2::bigint IS NULL OR u\.id = \$2::bigint/);
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /FROM teams t JOIN team_members tm ON tm\.team_id = t\.id WHERE t\.project_id = \$1::bigint/);
});

test("each evidence query uses the same conditions as its count, scoped to the project", () => {
  assert.match(COMMIT_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND c\.author_id = \$2::bigint/);
  assert.match(PULL_REQUEST_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND p\.author_id = \$2::bigint/);
  assert.match(REVIEW_EVIDENCE_SQL, /r\.project_id = \$1::bigint AND rv\.reviewer_id = \$2::bigint/);
  assert.match(ISSUE_EVIDENCE_SQL, /p\.author_id = \$2::bigint AND p\.status = 'merged' AND i\.status = 'closed'/);
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /p\.author_id = u\.id AND p\.status = 'merged' AND i\.status = 'closed'/);
  for (const sql of [COMMIT_EVIDENCE_SQL, PULL_REQUEST_EVIDENCE_SQL, REVIEW_EVIDENCE_SQL, ISSUE_EVIDENCE_SQL]) assert.match(sql, /LIMIT \$3$/);
});

test("members are listed highest score first, ties by name", async () => {
  const row = (user_id: string, full_name: string, commits: number) => ({ ...counts, commits, user_id, full_name, role: "student" });
  const list = await listMemberContributions("4", "77", async (_t, p) => {
    assert.deepEqual(p, ["4", null, "77"]); // project, no single-user filter, the viewer
    return [row("1", "Zed", 5), row("2", "Amy", 5), row("3", "Bob", 50)];
  });
  assert.deepEqual(list.map((m) => m.full_name), ["Bob", "Amy", "Zed"]);
  assert.equal(list[0].score, 50 + 15 + 6 + 2);
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

test("the member query only returns members the viewer may see: mentor of the project, lead of the member's team, or themselves", () => {
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /vp\.id = \$1::bigint AND vp\.mentor_id = \$3::bigint/); // mentor of this very project
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /OR u\.id = \$3::bigint OR EXISTS/); // a member sees their own row
  assert.match(MEMBER_CONTRIBUTIONS_SQL, /vt\.project_id = \$1::bigint AND vt\.lead_id = \$3::bigint AND vtm\.user_id = u\.id/); // lead of that member's team in this project
  assert.doesNotMatch(MEMBER_CONTRIBUTIONS_SQL, /\$3::bigint IS NULL/); // there is no "no viewer" bypass
});

test("the project list only offers projects where the viewer is the mentor, a team lead or a team member", async () => {
  assert.match(LIST_PROJECTS_SQL, /p\.mentor_id = \$1::bigint OR EXISTS/);
  assert.match(LIST_PROJECTS_SQL, /t\.lead_id = \$1::bigint OR EXISTS \(SELECT 1 FROM team_members tm WHERE tm\.team_id = t\.id AND tm\.user_id = \$1::bigint\)/);
  let seen: readonly unknown[] = [];
  await listProjects("5", async (t, p) => { assert.equal(t, LIST_PROJECTS_SQL); seen = p; return []; });
  assert.deepEqual(seen, ["5"]);
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
