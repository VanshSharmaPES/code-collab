// Integration test against a REAL PostgreSQL: who may see and act on which project's issues and pull requests.
// Skipped unless TEST_PG_ADMIN_URL is set (a local server, ideally the "postgres" maintenance database):
//   TEST_PG_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5433/postgres npm test
// It creates its own database (cc_access_test_*), applies the schema there, and drops only that database.
// The self-review trigger and the merge procedure are applied too when db/schema/03 and 04 are present in this checkout.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import {
  RepositoryNotFoundError, countIssues, createIssue, getIssue, listIssues, listRepositories, listWritableRepositories, updateIssue,
} from "../src/lib/issues";
import {
  PullRequestNotFoundError, PullRequestRuleError, PullRequestStatusError, countPullRequests, getPullRequest, listPullRequests, transitionPullRequest,
} from "../src/lib/pull-requests";
import { listUsers } from "../src/lib/users";

const adminUrl = process.env.TEST_PG_ADMIN_URL;
if (adminUrl) {
  const u = new URL(adminUrl);
  assert.ok(["postgres:", "postgresql:"].includes(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname), "TEST_PG_ADMIN_URL must be a local PostgreSQL server");
  assert.notEqual(decodeURIComponent(u.pathname.slice(1)), "codecollab", "point the admin URL at the postgres maintenance database, not codecollab");
}
const schema = (f: string) => join(process.cwd(), "db/schema", f);
const haveRules = existsSync(schema("03_merge_pull_request.sql")) && existsSync(schema("04_triggers.sql"));
const input = { title: "t", body: null, status: "open", priority: "low" } as const;

// People: users 1..9. Project A: mentor 1, team lead 2, members 3 (also PR author) and 4. Project B: mentor 5, lead 6, member 7.
// User 8 is on no team at all.
const [MENTOR_A, LEAD_A, MEMBER_A, MEMBER_A2, MENTOR_B, LEAD_B, MEMBER_B, NOBODY] = ["1", "2", "3", "4", "5", "6", "7", "8"];

describe("project access against a real PostgreSQL", { skip: adminUrl ? false : "set TEST_PG_ADMIN_URL to a local PostgreSQL to run" }, () => {
  const dbName = `cc_access_test_${randomBytes(6).toString("hex")}`;
  let admin: Client;
  let db: Client;
  const run = <T,>(text: string, params: readonly unknown[]) => db.query(text, [...params]).then((r) => r.rows as T[]);
  const q = (text: string, params: unknown[] = []) => db.query(text, params);
  const status = async (id: string) => (await q("select status from pull_requests where id = $1", [id])).rows[0].status as string;
  let issueA = "", issueB = "", prA = "", prB = "", prA2 = "", repoA = "", repoB = "";

  before(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(adminUrl as string); u.pathname = `/${dbName}`;
    db = new Client({ connectionString: u.toString() });
    await db.connect();
    for (const f of ["01_core.sql", "02_rest.sql", ...(haveRules ? ["03_merge_pull_request.sql", "04_triggers.sql"] : [])]) await db.query(readFileSync(schema(f), "utf8"));
    for (let i = 1; i <= 8; i++) await q("insert into users (email, full_name, password_hash, role) values ($1, $2, 'x', $3)", [`u${i}@t.test`, `User ${i}`, i === 1 || i === 5 ? "mentor" : i === 2 || i === 6 ? "lead" : "student"]);
    await q("insert into projects (name, mentor_id) values ('A', 1), ('B', 5)");
    await q("insert into teams (project_id, name, lead_id) values (1, 'ta', 2), (2, 'tb', 6)");
    await q("insert into team_members (team_id, user_id) values (1, 2), (1, 3), (1, 4), (2, 6), (2, 7)");
    repoA = (await q("insert into repositories (project_id, name) values (1, 'repo-a') returning id")).rows[0].id;
    repoB = (await q("insert into repositories (project_id, name) values (2, 'repo-b') returning id")).rows[0].id;
    await q("insert into repositories (project_id, name, github_url) values (1, 'mirror-a', 'https://github.com/o/m')");
    issueA = (await q("insert into issues (repository_id, number, title) values ($1, 1, 'issue in A') returning id", [repoA])).rows[0].id;
    issueB = (await q("insert into issues (repository_id, number, title) values ($1, 1, 'issue in B') returning id", [repoB])).rows[0].id;
    prA = (await q("insert into pull_requests (repository_id, number, title, author_id) values ($1, 1, 'pr in A', 3) returning id", [repoA])).rows[0].id;
    prA2 = (await q("insert into pull_requests (repository_id, number, title, author_id) values ($1, 2, 'second pr in A', 4) returning id", [repoA])).rows[0].id;
    prB = (await q("insert into pull_requests (repository_id, number, title, author_id) values ($1, 1, 'pr in B', 7) returning id", [repoB])).rows[0].id;
  });
  after(async () => {
    await db?.end();
    if (admin) {
      assert.match(dbName, /^cc_access_test_[0-9a-f]{12}$/);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); // only the database this test created
      await admin.end();
    }
  });

  it("every participant of project A sees its issues and nobody outside does", async () => {
    for (const who of [MENTOR_A, LEAD_A, MEMBER_A, MEMBER_A2]) {
      assert.deepEqual((await listIssues({ repositoryId: null, status: null }, 1, who, run)).map((i) => i.title), ["issue in A"], `user ${who}`);
      assert.equal(await countIssues({ repositoryId: null, status: null }, who, run), 1);
      assert.equal((await getIssue(issueA, who, run))?.title, "issue in A");
    }
    for (const who of [MENTOR_B, LEAD_B, MEMBER_B]) {
      assert.deepEqual((await listIssues({ repositoryId: null, status: null }, 1, who, run)).map((i) => i.title), ["issue in B"]);
      assert.equal(await getIssue(issueA, who, run), null, "project A's issue is invisible to project B");
      assert.equal(await getIssue(issueB, who, run).then((i) => i?.title), "issue in B");
    }
    for (const who of [NOBODY, "9999"]) {
      assert.deepEqual(await listIssues({ repositoryId: null, status: null }, 1, who, run), []);
      assert.equal(await countIssues({ repositoryId: null, status: null }, who, run), 0);
      assert.equal(await getIssue(issueA, who, run), null);
      assert.equal(await getIssue(issueB, who, run), null);
    }
  });

  it("an issue filter by a repository of another project returns nothing", async () => {
    assert.deepEqual(await listIssues({ repositoryId: repoB, status: null }, 1, MEMBER_A, run), []);
    assert.equal(await countIssues({ repositoryId: repoB, status: null }, MEMBER_A, run), 0);
  });

  it("repository lists contain only the viewer's projects, and the writable list also excludes GitHub mirrors", async () => {
    assert.deepEqual((await listRepositories(MEMBER_A, run)).map((r) => r.name).sort(), ["mirror-a", "repo-a"]);
    assert.deepEqual((await listWritableRepositories(MEMBER_A, run)).map((r) => r.name), ["repo-a"]);
    assert.deepEqual((await listRepositories(MEMBER_B, run)).map((r) => r.name), ["repo-b"]);
    assert.deepEqual(await listRepositories(NOBODY, run), []);
  });

  it("creating an issue works inside your project and looks like a missing repository anywhere else", async () => {
    const id = await createIssue(repoA, input, MEMBER_A, run);
    assert.equal((await q("select author_id::text a from issues where id = $1", [id])).rows[0].a, MEMBER_A);
    await assert.rejects(createIssue(repoB, input, MEMBER_A, run), RepositoryNotFoundError);
    await assert.rejects(createIssue(repoA, input, NOBODY, run), RepositoryNotFoundError);
    await assert.rejects(createIssue(repoA, input, MEMBER_B, run), RepositoryNotFoundError);
    assert.equal((await q("select count(*)::int n from issues")).rows[0].n, 3); // nothing was inserted by the refused calls
  });

  it("editing an issue works for participants and does nothing for anyone else", async () => {
    assert.equal(await updateIssue(issueA, { ...input, title: "edited by a member" }, MEMBER_A2, run), true);
    assert.equal(await updateIssue(issueA, { ...input, title: "edited by an outsider" }, MEMBER_B, run), false);
    assert.equal(await updateIssue(issueA, { ...input, title: "edited by nobody" }, NOBODY, run), false);
    assert.equal(await updateIssue(issueB, { ...input, title: "cross-project edit" }, MEMBER_A, run), false);
    assert.equal((await q("select title from issues where id = $1", [issueA])).rows[0].title, "edited by a member");
    assert.equal((await q("select title from issues where id = $1", [issueB])).rows[0].title, "issue in B");
  });

  it("pull requests: lists, counts and details are limited to the viewer's projects", async () => {
    assert.deepEqual((await listPullRequests({ repositoryId: null, status: null }, 1, 25, MEMBER_A, run)).map((p) => p.title).sort(), ["pr in A", "second pr in A"]);
    assert.equal(await countPullRequests({ repositoryId: null, status: null }, MEMBER_A, run), 2);
    assert.equal(await countPullRequests({ repositoryId: null, status: null }, MEMBER_B, run), 1);
    assert.equal(await countPullRequests({ repositoryId: null, status: null }, NOBODY, run), 0);
    assert.equal(await getPullRequest(prA, MEMBER_B, run), null);
    assert.equal((await getPullRequest(prA, MENTOR_A, run))?.title, "pr in A");
    assert.deepEqual(await listPullRequests({ repositoryId: repoB, status: null }, 1, 25, MEMBER_A, run), []);
  });

  it("an outsider cannot approve, close, reopen or merge: the pull request looks missing and nothing changes", async () => {
    for (const action of ["approve", "close", "reopen", "merge"] as const) {
      await assert.rejects(transitionPullRequest(prA, action, MEMBER_B, run), PullRequestNotFoundError, `member of B: ${action}`);
      await assert.rejects(transitionPullRequest(prA, action, NOBODY, run), PullRequestNotFoundError, `user without a team: ${action}`);
    }
    await assert.rejects(transitionPullRequest(prA, "approve", MENTOR_B, run), PullRequestNotFoundError);
    assert.equal(await status(prA), "open");
    assert.equal((await q("select count(*)::int n from pr_reviews")).rows[0].n, 0);
  });

  it("closing and reopening: the author, a team lead or the mentor may; another member may not", async () => {
    await assert.rejects(transitionPullRequest(prA, "close", MEMBER_A2, run), (e) => e instanceof PullRequestRuleError && e.code === "forbidden");
    assert.equal(await status(prA), "open");
    await transitionPullRequest(prA, "close", MEMBER_A, run); // the author
    assert.equal(await status(prA), "closed");
    await assert.rejects(transitionPullRequest(prA, "reopen", MEMBER_A2, run), (e) => e instanceof PullRequestRuleError && e.code === "forbidden");
    await transitionPullRequest(prA, "reopen", LEAD_A, run); // a team lead
    assert.equal(await status(prA), "open");
    await transitionPullRequest(prA, "close", MENTOR_A, run); // the mentor
    assert.equal(await status(prA), "closed");
    await transitionPullRequest(prA, "reopen", MEMBER_A, run);
    await assert.rejects(transitionPullRequest(prA2, "close", MEMBER_A, run), (e) => e instanceof PullRequestRuleError && e.code === "forbidden"); // a member, not the author
    await assert.rejects(transitionPullRequest(prB, "close", LEAD_A, run), PullRequestNotFoundError); // a lead of another project
  });

  it("approving writes a real review for participants only", { skip: haveRules ? false : "03/04 schema files are not in this checkout" }, async () => {
    await assert.rejects(transitionPullRequest(prA, "approve", MEMBER_A, run), (e) => e instanceof PullRequestRuleError && e.code === "selfApproval"); // own pull request
    assert.equal(await status(prA), "open");
    await transitionPullRequest(prA, "approve", MEMBER_A2, run);
    assert.equal(await status(prA), "approved");
    assert.deepEqual((await q("select reviewer_id::text r, verdict from pr_reviews where pull_request_id = $1", [prA])).rows, [{ r: MEMBER_A2, verdict: "approved" }]);
    await assert.rejects(transitionPullRequest(prA, "approve", MEMBER_A2, run), (e) => e instanceof PullRequestRuleError && e.code === "alreadyReviewed");
    await assert.rejects(transitionPullRequest(prA, "approve", MEMBER_B, run), PullRequestNotFoundError);
    assert.equal((await q("select count(*)::int n from pr_reviews where pull_request_id = $1", [prA])).rows[0].n, 1);
  });

  it("merging: a member is refused by the procedure, an outsider sees nothing, a lead or mentor can merge", { skip: haveRules ? false : "03/04 schema files are not in this checkout" }, async () => {
    await assert.rejects(transitionPullRequest(prA, "merge", MEMBER_A2, run), (e) => e instanceof PullRequestRuleError && e.code === "notMerger");
    await assert.rejects(transitionPullRequest(prA, "merge", MEMBER_B, run), PullRequestNotFoundError);
    await assert.rejects(transitionPullRequest(prA, "merge", LEAD_B, run), PullRequestNotFoundError); // a lead, but of another project
    assert.equal(await status(prA), "approved");
    await transitionPullRequest(prA, "merge", LEAD_A, run);
    assert.equal(await status(prA), "merged");
    await assert.rejects(transitionPullRequest(prA, "merge", LEAD_A, run), PullRequestStatusError);
  });

  it("the users list shows the viewer and the people of their projects, and nobody else", async () => {
    const ids = async (who: string) => (await listUsers(who, run)).map((u) => u.id);
    for (const who of [MENTOR_A, LEAD_A, MEMBER_A, MEMBER_A2]) assert.deepEqual(await ids(who), ["1", "2", "3", "4"], `user ${who}`);
    for (const who of [MENTOR_B, LEAD_B, MEMBER_B]) assert.deepEqual(await ids(who), ["5", "6", "7"], `user ${who}`);
    assert.deepEqual(await ids(NOBODY), [NOBODY], "someone on no project sees only themselves");
  });

  it("a GitHub-mirrored repository stays read-only even for its own project's participants", async () => {
    const mirror = (await q("select id from repositories where name = 'mirror-a'")).rows[0].id;
    await assert.rejects(createIssue(mirror, input, MEMBER_A, run));
    const mpr = (await q("insert into pull_requests (repository_id, number, title, author_id) values ($1, 9, 'mirrored pr', 3) returning id", [mirror])).rows[0].id;
    await assert.rejects(transitionPullRequest(mpr, "close", MEMBER_A, run));
    assert.equal(await status(mpr), "open");
  });
});
