// Integration test against a REAL PostgreSQL: who may see which project member's contribution row (P2-14).
// Skipped unless TEST_PG_URL is set to a local database that already has contribution_counts() and score_from_counts()
// (db/schema/05_contribution_score.sql):
//   TEST_PG_URL=postgresql://USER:PASSWORD@localhost:5433/codecollab npm test
// It writes nothing persistent. The tables it needs are created as TEMPORARY tables of this one connection, which shadow
// the real tables of the same name for this session only and vanish when the connection closes. Every insert names
// pg_temp explicitly, so it cannot reach a real table.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { MEMBER_CONTRIBUTIONS_SQL, listMemberContributions, listProjects } from "../src/lib/contributions";

const url = process.env.TEST_PG_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["postgres:", "postgresql:"].includes(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname), "TEST_PG_URL must be a local PostgreSQL server");
}

// Project A (id 1): mentor 1. Team 1 (lead 2): members 2, 3. Team 2 (lead 6): members 6, 4. User 10 is on no team.
// Project B (id 2): mentor 5. Team 3 (lead 8): members 8, 9.
const [MENTOR_A, LEAD_1, MEMBER_1, MEMBER_2, MENTOR_B, LEAD_2, LEAD_B, MEMBER_B, OUTSIDER] = ["1", "2", "3", "4", "5", "6", "8", "9", "10"];
const A = "1";
const B = "2";

describe("member contribution visibility against a real PostgreSQL", { skip: url ? false : "set TEST_PG_URL to a local PostgreSQL to run" }, () => {
  let db: Client;
  const q = (text: string, params: unknown[] = []) => db.query(text, params);
  const run = <T,>(text: string, params: readonly unknown[]) => db.query(text, [...params]).then((r) => r.rows as T[]);
  const members = async (project: string, viewer: string) => (await listMemberContributions(project, viewer, run)).map((m) => m.user_id).sort();

  before(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    const fn = await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('contribution_counts', 'score_from_counts')");
    assert.equal(fn.rows[0].n, 2, "contribution_counts() and score_from_counts() must exist in this database");
    for (const ddl of [
      "users (id bigint, full_name text, role text)",
      "projects (id bigint, name text, mentor_id bigint)",
      "teams (id bigint, project_id bigint, lead_id bigint)",
      "team_members (team_id bigint, user_id bigint)",
      "repositories (id bigint, project_id bigint)",
      "commits (id bigint, repository_id bigint, author_id bigint)",
      "pull_requests (id bigint, repository_id bigint, author_id bigint, status text)",
      "pr_reviews (id bigint, pull_request_id bigint, reviewer_id bigint)",
      "pr_issue_links (pull_request_id bigint, issue_id bigint)",
      "issues (id bigint, status text)",
    ]) await q(`CREATE TEMP TABLE ${ddl}`);
    for (const [id, name] of [[1, "Mentor A"], [2, "Lead One"], [3, "Member One"], [4, "Member Two"], [5, "Mentor B"], [6, "Lead Two"], [8, "Lead B"], [9, "Member B"], [10, "Outsider"]]) {
      await q("INSERT INTO pg_temp.users VALUES ($1, $2, 'student')", [id, name]);
    }
    await q("INSERT INTO pg_temp.projects VALUES (1, 'A', 1), (2, 'B', 5)");
    await q("INSERT INTO pg_temp.teams VALUES (1, 1, 2), (2, 1, 6), (3, 2, 8)");
    await q("INSERT INTO pg_temp.team_members VALUES (1, 2), (1, 3), (2, 6), (2, 4), (3, 8), (3, 9)");
    await q("INSERT INTO pg_temp.repositories VALUES (1, 1), (2, 2)");
    // Member One: 3 commits and 2 opened, unmerged pull requests (score 3). Member Two: one merged pull request (score 5).
    await q("INSERT INTO pg_temp.commits VALUES (1, 1, 3), (2, 1, 3), (3, 1, 3)");
    await q("INSERT INTO pg_temp.pull_requests VALUES (1, 1, 3, 'open'), (2, 1, 3, 'closed'), (3, 1, 4, 'merged')");
  });

  after(async () => { await db?.end(); }); // drops the temporary tables

  it("the mentor of the project sees every member", async () => {
    assert.deepEqual(await members(A, MENTOR_A), [LEAD_1, MEMBER_1, MEMBER_2, LEAD_2].sort());
  });

  it("a team lead sees the members of every team in the project, not only their own", async () => {
    const everyone = [LEAD_1, MEMBER_1, MEMBER_2, LEAD_2].sort();
    assert.deepEqual(await members(A, LEAD_1), everyone); // includes team 2's members 4 and 6
    assert.deepEqual(await members(A, LEAD_2), everyone); // includes team 1's members 2 and 3
  });

  it("a regular member sees only their own row", async () => {
    assert.deepEqual(await members(A, MEMBER_1), [MEMBER_1]);
    assert.deepEqual(await members(A, MEMBER_2), [MEMBER_2]);
  });

  it("someone with no access sees no rows", async () => {
    assert.deepEqual(await members(A, OUTSIDER), []);
  });

  it("access is scoped to the requested project: a manager or member of one project sees nothing of another", async () => {
    for (const viewer of [MENTOR_B, LEAD_B, MEMBER_B]) assert.deepEqual(await members(A, viewer), [], `viewer ${viewer} on project A`);
    for (const viewer of [MENTOR_A, LEAD_1, LEAD_2, MEMBER_1]) assert.deepEqual(await members(B, viewer), [], `viewer ${viewer} on project B`);
    assert.deepEqual(await members(B, MENTOR_B), [LEAD_B, MEMBER_B].sort());
    assert.deepEqual(await members(B, LEAD_B), [LEAD_B, MEMBER_B].sort());
  });

  it("the single-member lookup that guards evidence follows the same rule", async () => {
    // getMemberEvidence only reads evidence when this query returns the row, so these are the evidence permissions.
    const one = (project: string, user: string, viewer: string) => run<{ user_id: string }>(MEMBER_CONTRIBUTIONS_SQL, [project, user, viewer]).then((r) => r.map((x) => x.user_id));
    assert.deepEqual(await one(A, MEMBER_2, MENTOR_A), [MEMBER_2]);
    assert.deepEqual(await one(A, MEMBER_2, LEAD_1), [MEMBER_2]); // a lead of another team
    assert.deepEqual(await one(A, MEMBER_2, MEMBER_1), []); // a plain member cannot open someone else
    assert.deepEqual(await one(A, MEMBER_1, MEMBER_1), [MEMBER_1]);
    assert.deepEqual(await one(A, MEMBER_2, OUTSIDER), []);
    assert.deepEqual(await one(A, MEMBER_2, LEAD_B), []); // a lead of a different project
    assert.deepEqual(await one(B, MEMBER_2, LEAD_B), []); // and the member is not in project B at all
  });

  it("scores come from the database: commits count, merged pull requests score 5, opened ones score nothing", async () => {
    const list = await listMemberContributions(A, MENTOR_A, run);
    const byUser = Object.fromEntries(list.map((m) => [m.user_id, m]));
    assert.equal(byUser[MEMBER_1].score, 3);
    assert.equal(byUser[MEMBER_1].prs_opened, 2);
    assert.equal(byUser[MEMBER_1].prs_merged, 0);
    assert.equal(byUser[MEMBER_2].score, 5);
    assert.equal(typeof byUser[MEMBER_2].score, "number");
    assert.deepEqual(list.map((m) => m.user_id).slice(0, 2), [MEMBER_2, MEMBER_1]); // highest score first
  });

  it("the project list offers a project to its mentor, leads and members, and to nobody else", async () => {
    const ids = async (viewer: string) => (await listProjects(viewer, run)).map((p) => p.id);
    for (const viewer of [MENTOR_A, LEAD_1, LEAD_2, MEMBER_1, MEMBER_2]) assert.deepEqual(await ids(viewer), [A], `viewer ${viewer}`);
    assert.deepEqual(await ids(MENTOR_B), [B]);
    assert.deepEqual(await ids(OUTSIDER), []);
  });
});
