import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubError, type GitHubApi, type GitHubResult } from "./github-client";
import {
  DEFAULT_REPOS,
  INSERT_COMMIT_SQL,
  SELECT_KNOWN_SHAS_SQL,
  SELECT_PROJECT_ID_SQL,
  SELECT_USERS_SQL,
  UPSERT_ISSUE_SQL,
  UPSERT_PROJECT_SQL,
  UPSERT_PULL_SQL,
  UPSERT_REPOSITORY_SQL,
  authorIdFor,
  estimateRequests,
  ingestRepository,
  loadUserIds,
  mapCommit,
  mapFiles,
  mapIssue,
  mapPull,
  mapRepository,
  parseIngestArgs,
  redactEmails,
  parseRepoSlug,
  planRepository,
  readGitHubToken,
  stripNul,
  type IngestDb,
  type Spool,
  type SpoolLine,
  type UserIds,
} from "./ingest-data";

const SLUG = "octo/widgets";
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const noUsers: UserIds = new Map();

// ---- payload builders ----

const ghCommit = (n: number, extra: Record<string, unknown> = {}) => ({
  sha: SHA(n),
  author: { login: "OctoCat" },
  commit: {
    author: { name: "Octo Cat", email: "octo@example.test", date: "2026-01-02T03:04:05Z" },
    committer: { date: "2026-01-02T03:04:06Z" },
    message: `commit ${n}`,
  },
  ...extra,
});
const DEFAULT_FILES: unknown[] = [{ filename: "a.py", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "SECRET-PATCH-TEXT" }];
const ghDetail = (n: number, files: unknown[] = DEFAULT_FILES) =>
  ghCommit(n, { stats: { additions: 3, deletions: 1, total: 4 }, files });
const ghIssue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `issue ${n}`, body: "body", state: "open", user: { login: "someone" },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", closed_at: null, ...extra,
});
const ghPull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `pr ${n}`, body: "desc", state: "open", user: { login: "someone" },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", merged_at: null, ...extra,
});
const REPO_META = { full_name: SLUG, name: "widgets", html_url: `https://github.com/${SLUG}`, default_branch: "trunk", description: "A repo", archived: false };

// ---- fake GitHub ----

type Route = { data: unknown; link?: Record<string, string> } | Error;
class FakeGitHub implements GitHubApi {
  requestCount = 0;
  calls: string[] = [];
  constructor(
    private routes: Record<string, Route>,
    private pages: Record<string, unknown[][]>,
  ) {}
  async getJson(path: string): Promise<GitHubResult> {
    this.calls.push(path);
    this.requestCount += 1;
    const route = this.routes[path];
    if (route instanceof Error) throw route;
    if (!route) throw new GitHubError(`no route for ${path}`, 404);
    return { data: route.data, link: route.link ?? {} };
  }
  async *paginate(path: string): AsyncGenerator<unknown[]> {
    this.calls.push(path);
    this.requestCount += 1;
    const route = this.routes[path];
    if (route instanceof Error) throw route;
    for (const page of this.pages[path] ?? []) yield page;
  }
}

const base = `/repos/${SLUG}`;
const COMMITS = `${base}/commits?per_page=100`;
const ISSUES = `${base}/issues?state=all&per_page=100&sort=created&direction=asc`;
const PULLS = `${base}/pulls?state=all&per_page=100&sort=created&direction=asc`;

function github(opts: { commitPages?: unknown[][]; details?: Record<number, Route>; issuePages?: unknown[][]; pullPages?: unknown[][]; errors?: Record<string, Error>; meta?: Record<string, unknown> } = {}) {
  const routes: Record<string, Route> = { [base]: { data: opts.meta ?? REPO_META }, ...(opts.errors ?? {}) };
  const commitPages = opts.commitPages ?? [[ghCommit(1), ghCommit(2)], [ghCommit(3)]];
  for (const n of commitPages.flat().map((c) => parseInt((c as { sha: string }).sha, 16))) {
    routes[`${base}/commits/${SHA(n)}?per_page=300`] = opts.details?.[n] ?? { data: ghDetail(n) };
  }
  return new FakeGitHub(routes, { [COMMITS]: commitPages, [ISSUES]: opts.issuePages ?? [], [PULLS]: opts.pullPages ?? [] });
}

// ---- fake database: models what the SQL is meant to do, with real transaction semantics ----

type Row = Record<string, unknown>;
type State = { projects: Record<string, string>; repos: Record<string, { id: string; projectId: string; defaultBranch: string; isSynthetic: unknown }>; commits: Record<string, Row>; issues: Record<string, Row>; pulls: Record<string, Row> };

class FakeDb implements IngestDb {
  state: State = { projects: {}, repos: {}, commits: {}, issues: {}, pulls: {} };
  calls: string[] = [];
  commitParamCounts: number[] = [];
  projectInserts: unknown[][] = []; // the parameters of every project insert, as sent
  committedTransactions = 0;
  private snapshot?: string;
  private nextId = 1;
  constructor(private opts: { users?: Array<{ id: string; github_username: string }>; failOn?: (text: string, params: readonly unknown[]) => boolean } = {}) {}

  async query(text: string, params: readonly unknown[] = []) {
    this.calls.push(text);
    if (this.opts.failOn?.(text, params)) throw Object.assign(new Error("db boom"), { code: "XX000" });
    const s = this.state;
    switch (text) {
      case "BEGIN":
        this.snapshot = JSON.stringify(s);
        return { rows: [], rowCount: null };
      case "COMMIT":
        this.snapshot = undefined;
        this.committedTransactions += 1;
        return { rows: [], rowCount: null };
      case "ROLLBACK":
        if (this.snapshot) this.state = JSON.parse(this.snapshot) as State;
        return { rows: [], rowCount: null };
      case UPSERT_PROJECT_SQL: {
        this.projectInserts.push([...params]);
        const name = params[0] as string;
        const isNew = !(name in s.projects);
        if (isNew) s.projects[name] = String(this.nextId++);
        return { rows: [], rowCount: isNew ? 1 : 0 };
      }
      case SELECT_PROJECT_ID_SQL:
        return { rows: [{ id: s.projects[params[0] as string] }], rowCount: 1 };
      case UPSERT_REPOSITORY_SQL: {
        const [projectId, , url, defaultBranch, isSynthetic] = params as [string, string, string, string, unknown];
        const existing = s.repos[url];
        if (existing) existing.defaultBranch = defaultBranch;
        else s.repos[url] = { id: String(this.nextId++), projectId, defaultBranch, isSynthetic };
        return { rows: [{ id: s.repos[url].id }], rowCount: 1 };
      }
      case SELECT_USERS_SQL:
        return { rows: this.opts.users ?? [], rowCount: (this.opts.users ?? []).length };
      case SELECT_KNOWN_SHAS_SQL: {
        const rows = Object.values(s.commits).filter((c) => c.repositoryId === params[0]).map((c) => ({ sha: c.sha }));
        return { rows, rowCount: rows.length };
      }
      case INSERT_COMMIT_SQL: {
        this.commitParamCounts.push(params.length);
        const [repositoryId, sha, authorId, message, additions, deletions, filesChanged, committedAt] = params;
        const key = `${repositoryId}:${sha}`;
        if (key in s.commits) return { rows: [], rowCount: 0 };
        s.commits[key] = { repositoryId, sha, authorId, message, additions, deletions, filesChanged, committedAt };
        return { rows: [], rowCount: 1 };
      }
      case UPSERT_ISSUE_SQL:
      case UPSERT_PULL_SQL: {
        const table = text === UPSERT_ISSUE_SQL ? s.issues : s.pulls;
        const [repositoryId, number, title, body, status, authorId, createdAt, updatedAt, closedOrMerged] = params;
        const key = `${repositoryId}:${number}`;
        const row = { repositoryId, number, title, body, status, authorId, createdAt, updatedAt, closedOrMerged };
        const existing = table[key];
        if (existing && !(Date.parse(existing.updatedAt as string) < Date.parse(updatedAt as string))) return { rows: [], rowCount: 0 };
        table[key] = existing ? { ...existing, ...row, createdAt: existing.createdAt } : row;
        return { rows: [], rowCount: 1 };
      }
      default:
        throw new Error(`unexpected SQL in test: ${text}`);
    }
  }
}

class FakeSpool implements Spool {
  lines: SpoolLine[] = [];
  async has(_repo: string, sha: string) {
    return this.lines.some((l) => l.sha === sha);
  }
  async append(_repo: string, lines: SpoolLine[]) {
    this.lines.push(...lines);
  }
}

const run = (gh: FakeGitHub, db: FakeDb, spool: FakeSpool, opts: { userIds?: UserIds; limit?: number } = {}) =>
  ingestRepository({ github: gh, db, spool, userIds: opts.userIds ?? noUsers, log: () => {} }, SLUG, opts.limit);

// ---- arguments ----

test("parseRepoSlug accepts owner/name and rejects anything else", () => {
  assert.equal(parseRepoSlug("pallets/flask"), "pallets/flask");
  for (const bad of ["flask", "a/b/c", "../etc", "a/..", "a b/c", "a/b?x=1", "a/b#frag", "/a/b", "https://github.com/a/b", ""]) {
    assert.throws(() => parseRepoSlug(bad), /Invalid repository/, JSON.stringify(bad));
  }
});

test("parseIngestArgs defaults to a dry run on the three approved repositories", () => {
  assert.deepEqual(parseIngestArgs([]), { apply: false, limit: undefined, repos: [...DEFAULT_REPOS] });
  assert.deepEqual([...DEFAULT_REPOS], ["pallets/flask", "expressjs/express", "pallets/click"]);
});

test("parseIngestArgs: --apply, --limit and repositories; strict about everything else", () => {
  assert.deepEqual(parseIngestArgs(["--apply", "--limit=25", "a/b", "c/d", "a/b"]), { apply: true, limit: 25, repos: ["a/b", "c/d"] });
  for (const bad of [["--aply"], ["--limit"], ["--limit=0"], ["--limit=-1"], ["--limit=abc"], ["--limit=1.5"], ["--limit=99999999"], ["--apply=1"], ["-x"]]) {
    assert.throws(() => parseIngestArgs(bad), /--limit|Unknown argument/, bad.join(" "));
  }
  assert.throws(() => parseIngestArgs(["not-a-slug"]), /Invalid repository/);
});

test("readGitHubToken: required only for --apply, never echoed", () => {
  assert.equal(readGitHubToken({}, false), undefined);
  assert.equal(readGitHubToken({ GITHUB_TOKEN: "" }, false), undefined);
  assert.throws(() => readGitHubToken({}, true), /not set/);
  assert.equal(readGitHubToken({ GITHUB_TOKEN: "abc123" }, true), "abc123");
  assert.throws(() => readGitHubToken({ GITHUB_TOKEN: "abc 123" }, false), (err: Error) => /whitespace/.test(err.message) && !err.message.includes("abc"));
});

// ---- mapping ----

test("mapRepository uses the full name as the project name and keeps the default branch", () => {
  assert.deepEqual(mapRepository(REPO_META), { projectName: SLUG, description: "A repo", name: "widgets", githubUrl: `https://github.com/${SLUG}`, defaultBranch: "trunk" });
  assert.throws(() => mapRepository({ name: "x" }), /missing/);
  assert.throws(() => mapRepository(null), /Unexpected/);
});

test("mapCommit takes stats from GitHub, files_changed from the file list, the committer date, and links authors case-insensitively", () => {
  const files = mapFiles(DEFAULT_FILES);
  const row = mapCommit(ghDetail(1), files, new Map([["octocat", "7"]]));
  assert.deepEqual(row, {
    sha: SHA(1), authorId: "7", authorLogin: "OctoCat", message: "commit 1",
    additions: 3, deletions: 1, filesChanged: 1, committedAt: "2026-01-02T03:04:06Z",
  });
  assert.equal(mapCommit(ghDetail(1), files, noUsers)?.authorId, null, "unknown login means NULL");
  assert.equal(mapCommit({ ...ghDetail(1), author: null }, files, new Map([["octocat", "7"]]))?.authorId, null, "no linked account means NULL");
});

test("mapCommit: lowercase sha, author date fallback, summed stats fallback, NUL stripped, invalid input rejected", () => {
  const upper = { ...ghCommit(255), sha: SHA(255).toUpperCase(), stats: undefined, commit: { author: { name: "A\u0000B", email: null, date: "2026-02-02T00:00:00Z" }, message: "m\u0000sg" } };
  const files = mapFiles([{ filename: "x", status: "added", additions: 5, deletions: 2, changes: 7 }, { filename: "y", additions: 1 }]);
  const row = mapCommit(upper, files, noUsers);
  assert.equal(row?.sha, SHA(255));
  assert.equal(row?.committedAt, "2026-02-02T00:00:00Z");
  assert.deepEqual([row?.additions, row?.deletions, row?.filesChanged], [6, 2, 2]);
  assert.equal(row?.message, "msg");
  for (const bad of [{ ...ghCommit(1), sha: "zzz" }, { ...ghCommit(1), sha: "abc" }, { ...ghCommit(1), commit: { message: "no date" } }, { ...ghCommit(1), commit: { author: { date: "not a date" } } }, null, "x"]) {
    assert.equal(mapCommit(bad, [], noUsers), null);
  }
});

test("mapFiles keeps only the file fields (never the patch) and defaults safely", () => {
  assert.deepEqual(mapFiles([{ filename: "a", status: "renamed", additions: 1, deletions: 2, changes: 3, previous_filename: "b", patch: "SECRET-PATCH-TEXT", blob_url: "u" }, "junk", { filename: "c", additions: -5 }]), [
    { filename: "a", status: "renamed", additions: 1, deletions: 2, changes: 3, previous_filename: "b" },
    { filename: "c", status: "modified", additions: 0, deletions: 0, changes: 0, previous_filename: null },
  ]);
});

test("mapIssue follows the table checks: closed <=> closed_at, nothing earlier than created_at", () => {
  assert.deepEqual(mapIssue(ghIssue(5), noUsers), { number: 5, title: "issue 5", body: "body", status: "open", authorId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", closedAt: null });
  const closed = mapIssue(ghIssue(6, { state: "closed", closed_at: "2026-01-03T00:00:00Z" }), noUsers);
  assert.deepEqual([closed?.status, closed?.closedAt], ["closed", "2026-01-03T00:00:00Z"]);
  assert.equal(mapIssue(ghIssue(7, { state: "closed", closed_at: null }), noUsers)?.closedAt, "2026-01-02T00:00:00Z", "closed without closed_at falls back to updated_at");
  assert.equal(mapIssue(ghIssue(8, { state: "open", closed_at: "2026-01-03T00:00:00Z" }), noUsers)?.closedAt, null, "an open issue never has closed_at");
  assert.equal(mapIssue(ghIssue(9, { updated_at: "2025-12-31T00:00:00Z" }), noUsers)?.updatedAt, "2026-01-01T00:00:00Z", "updated_at is never before created_at");
  assert.equal(mapIssue(ghIssue(10, { state: "closed", closed_at: "2025-01-01T00:00:00Z" }), noUsers)?.closedAt, "2026-01-01T00:00:00Z");
  assert.equal(mapIssue(ghIssue(11, { body: "a\u0000b" }), noUsers)?.body, "ab");
  assert.equal(mapIssue(ghIssue(12, { user: { login: "OCTOCAT" } }), new Map([["octocat", "3"]]))?.authorId, "3");
  for (const bad of [{ title: "no number" }, ghIssue(1, { created_at: undefined }), null]) assert.equal(mapIssue(bad, noUsers), null);
});

test("mapPull maps merged/closed/open, never 'approved', and keeps merged_at consistent", () => {
  assert.equal(mapPull(ghPull(1), noUsers)?.status, "open");
  const closed = mapPull(ghPull(2, { state: "closed" }), noUsers);
  assert.deepEqual([closed?.status, closed?.mergedAt], ["closed", null]);
  const merged = mapPull(ghPull(3, { state: "closed", merged_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" }), noUsers);
  assert.deepEqual([merged?.status, merged?.mergedAt, merged?.updatedAt], ["merged", "2026-01-05T00:00:00Z", "2026-01-05T00:00:00Z"]);
  assert.equal(mapPull(ghPull(4, { merged_at: "2025-01-01T00:00:00Z" }), noUsers)?.mergedAt, "2026-01-01T00:00:00Z", "merged_at is never before created_at");
  assert.equal(mapPull(ghPull(5, { draft: true }), noUsers)?.status, "open");
  assert.equal(mapPull({ title: "x" }, noUsers), null);
});

test("authorIdFor and stripNul", () => {
  assert.equal(authorIdFor("Octo", new Map([["octo", "9"]])), "9");
  assert.equal(authorIdFor(null, new Map([["octo", "9"]])), null);
  assert.equal(stripNul("a\u0000\u0000b"), "ab");
});

// ---- SQL ----

test("every statement is parameterized, uses explicit conflict targets, and is never destructive", () => {
  const writes = [UPSERT_PROJECT_SQL, UPSERT_REPOSITORY_SQL, INSERT_COMMIT_SQL, UPSERT_ISSUE_SQL, UPSERT_PULL_SQL];
  for (const sql of [...writes, SELECT_PROJECT_ID_SQL, SELECT_USERS_SQL, SELECT_KNOWN_SHAS_SQL]) {
    assert.doesNotMatch(sql, /\b(DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i);
    assert.doesNotMatch(sql, /'[^']*'/, "no quoted literals: every value is a bound parameter");
  }
  for (const sql of writes) {
    assert.match(sql, /^INSERT INTO /);
    assert.match(sql, /ON CONFLICT \([a-z_, ]+\) DO /, "explicit conflict target");
    assert.doesNotMatch(sql, /ON CONFLICT DO /);
  }
  assert.match(UPSERT_PROJECT_SQL, /ON CONFLICT \(name\) DO NOTHING$/);
  assert.match(UPSERT_REPOSITORY_SQL, /ON CONFLICT \(github_url\) DO UPDATE/);
  assert.match(INSERT_COMMIT_SQL, /ON CONFLICT \(repository_id, sha\) DO NOTHING$/);
  // Contributor identity is not persisted: the nullable author_name/author_email columns are left unset.
  assert.doesNotMatch(INSERT_COMMIT_SQL, /author_name|author_email|author_login/);
  assert.equal((INSERT_COMMIT_SQL.match(/\$\d+/g) ?? []).length, 8, "eight bound values: no name or email");
  assert.match(UPSERT_ISSUE_SQL, /ON CONFLICT \(repository_id, number\) DO UPDATE/);
  assert.match(UPSERT_PULL_SQL, /ON CONFLICT \(repository_id, number\) DO UPDATE/);
  // Only newer upstream data may overwrite an existing issue/PR: local edits survive a re-run.
  assert.match(UPSERT_ISSUE_SQL, /WHERE issues\.updated_at < EXCLUDED\.updated_at$/);
  assert.match(UPSERT_PULL_SQL, /WHERE pull_requests\.updated_at < EXCLUDED\.updated_at$/);
  assert.doesNotMatch(UPSERT_ISSUE_SQL, /(priority|assignee_id)\s*=/, "local-only fields are never overwritten");
  assert.doesNotMatch(UPSERT_PULL_SQL, /merged_by\s*=/);
  for (const sql of [SELECT_PROJECT_ID_SQL, SELECT_USERS_SQL, SELECT_KNOWN_SHAS_SQL]) assert.match(sql, /^SELECT /);
});

// ---- dry run ----

test("estimateRequests does the arithmetic and respects --limit", () => {
  assert.deepEqual(estimateRequests({ commits: 5562, pulls: 2912, maxNumber: 6172 }), { metadata: 1, commitPages: 56, commitDetails: 5562, pullPages: 30, issuePages: 62, total: 5711 });
  assert.deepEqual(estimateRequests({ commits: 5562, pulls: 2912, maxNumber: 6172 }, 50), { metadata: 1, commitPages: 1, commitDetails: 50, pullPages: 1, issuePages: 1, total: 54 });
  assert.equal(estimateRequests({ commits: 10, pulls: 0, maxNumber: 0 }, 50).commitDetails, 10);
});

test("planRepository reads sizes with a few read-only requests and touches nothing else", async () => {
  const gh = new FakeGitHub(
    {
      [base]: { data: { ...REPO_META, archived: true } },
      [`${base}/commits?per_page=1`]: { data: [ghCommit(1)], link: { last: `https://api.github.com/repositories/1/commits?per_page=1&page=5562` } },
      [`${base}/pulls?state=all&per_page=1`]: { data: [ghPull(1)], link: { last: `https://api.github.com/repositories/1/pulls?state=all&per_page=1&page=2912` } },
      [`${base}/issues?state=all&per_page=1&sort=created&direction=desc`]: { data: [ghIssue(6172)] },
    },
    {},
  );
  const plan = await planRepository(gh, SLUG);
  assert.deepEqual([plan.commits, plan.pulls, plan.issues, plan.archived, plan.defaultBranch], [5562, 2912, 3260, true, "trunk"]);
  assert.equal(plan.requests.total, 5711);
  assert.equal(gh.requestCount, 4);
  assert.ok(gh.calls.every((c) => !c.includes("/commits/")), "no per-commit detail request in a dry run");
});

test("planRepository handles an empty repository", async () => {
  const gh = new FakeGitHub({ [base]: { data: REPO_META }, [`${base}/commits?per_page=1`]: { data: [] }, [`${base}/pulls?state=all&per_page=1`]: { data: [] }, [`${base}/issues?state=all&per_page=1&sort=created&direction=desc`]: { data: [] } }, {});
  const plan = await planRepository(gh, SLUG);
  assert.deepEqual([plan.commits, plan.pulls, plan.issues], [0, 0, 0]);
});

// ---- ingestion ----

test("loadUserIds lowercases GitHub usernames", async () => {
  const db = new FakeDb({ users: [{ id: "4", github_username: "OctoCat" }] });
  assert.deepEqual([...(await loadUserIds(db))], [["octocat", "4"]]);
});

test("a first run creates one project and one real repository, then every commit, issue and pull request", async () => {
  const gh = github({ issuePages: [[ghIssue(1), ghPull(2, { pull_request: {} }), ghIssue(3, { state: "closed", closed_at: "2026-01-03T00:00:00Z" })]], pullPages: [[ghPull(2), ghPull(4, { state: "closed", merged_at: "2026-01-05T00:00:00Z" })]] });
  const db = new FakeDb();
  const spool = new FakeSpool();
  const summary = await run(gh, db, spool, { userIds: new Map([["octocat", "7"]]) });

  assert.deepEqual(summary.commits, { listed: 3, fetched: 3, inserted: 3, alreadyStored: 0, invalid: 0 });
  assert.deepEqual(summary.issues, { listed: 2, upserted: 2, unchanged: 0 });
  assert.deepEqual(summary.pulls, { listed: 2, upserted: 2, unchanged: 0 });
  assert.deepEqual(Object.keys(db.state.projects), [SLUG], "one project per repository");
  const repo = Object.values(db.state.repos);
  assert.equal(repo.length, 1);
  assert.deepEqual([repo[0].defaultBranch, repo[0].isSynthetic], ["trunk", false]);
  assert.equal(Object.keys(db.state.commits).length, 3);
  assert.ok(Object.values(db.state.commits).every((c) => c.authorId === "7" && c.additions === 3 && c.filesChanged === 1));
  assert.deepEqual(Object.values(db.state.issues).map((i) => i.number), [1, 3], "the pull request in the issues list was skipped");
  assert.deepEqual(Object.values(db.state.pulls).map((p) => p.status), ["open", "merged"]);
  assert.equal(db.committedTransactions, 1 + 2 + 1 + 1, "repository, two commit pages, issues, pull requests");
});

test("changed-file details are spooled per commit, without patch text", async () => {
  const gh = github({ commitPages: [[ghCommit(1)]] , details: { 1: { data: ghDetail(1, [{ filename: "a.py", status: "renamed", additions: 1, deletions: 0, changes: 1, previous_filename: "b.py", patch: "SECRET-PATCH-TEXT" }]) } } });
  const spool = new FakeSpool();
  await run(gh, new FakeDb(), spool);
  assert.deepEqual(spool.lines, [{ repo: SLUG, sha: SHA(1), committed_at: "2026-01-02T03:04:06Z", author_login: "OctoCat", files: [{ filename: "a.py", status: "renamed", additions: 1, deletions: 0, changes: 1, previous_filename: "b.py" }] }]);
  assert.ok(!JSON.stringify(spool.lines).includes("SECRET-PATCH-TEXT"));
});

test("a rerun is idempotent: no detail requests, no duplicate rows or spool lines, unchanged issues stay unchanged", async () => {
  const make = () => github({ issuePages: [[ghIssue(1)]], pullPages: [[ghPull(2)]] });
  const db = new FakeDb();
  const spool = new FakeSpool();
  await run(make(), db, spool);
  const before = JSON.stringify(db.state);
  const second = make();
  const summary = await run(second, db, spool);
  assert.deepEqual(summary.commits, { listed: 3, fetched: 0, inserted: 0, alreadyStored: 3, invalid: 0 });
  assert.deepEqual([summary.issues.upserted, summary.issues.unchanged, summary.pulls.upserted, summary.pulls.unchanged], [0, 1, 0, 1]);
  assert.ok(second.calls.every((c) => !c.includes("/commits/")), "no per-commit request for stored commits");
  assert.equal(JSON.stringify(db.state), before);
  assert.equal(spool.lines.length, 3);
});

test("newer upstream data updates an issue, but a newer local edit is not overwritten", async () => {
  const db = new FakeDb();
  await run(github({ commitPages: [], issuePages: [[ghIssue(1, { title: "v1" })]] }), db, new FakeSpool());
  await run(github({ commitPages: [], issuePages: [[ghIssue(1, { title: "v2", updated_at: "2026-02-01T00:00:00Z" })]] }), db, new FakeSpool());
  const key = Object.keys(db.state.issues)[0];
  assert.equal(db.state.issues[key].title, "v2");
  assert.equal(db.state.issues[key].createdAt, "2026-01-01T00:00:00Z", "created_at is preserved");

  db.state.issues[key] = { ...db.state.issues[key], title: "local edit", updatedAt: "2026-03-01T00:00:00Z" };
  const summary = await run(github({ commitPages: [], issuePages: [[ghIssue(1, { title: "v3", updated_at: "2026-02-15T00:00:00Z" })]] }), db, new FakeSpool());
  assert.equal(db.state.issues[key].title, "local edit");
  assert.equal(summary.issues.unchanged, 1);
});

test("a GitHub failure mid-page keeps the commits already fetched, and a rerun fetches only the rest", async () => {
  const failing = github({ details: { 2: new GitHubError("GitHub API error 500 for /x.", 500) } });
  const db = new FakeDb();
  const spool = new FakeSpool();
  await assert.rejects(run(failing, db, spool), (err: GitHubError) => err.status === 500);
  assert.deepEqual(Object.values(db.state.commits).map((c) => c.sha), [SHA(1)], "commit 1 was saved before the failure");

  const healthy = github();
  const summary = await run(healthy, db, spool);
  assert.deepEqual(summary.commits, { listed: 3, fetched: 2, inserted: 2, alreadyStored: 1, invalid: 0 });
  assert.equal(Object.keys(db.state.commits).length, 3);
  assert.ok(!healthy.calls.includes(`${base}/commits/${SHA(1)}?per_page=300`), "the stored commit was not fetched again");
});

test("a database failure rolls the page back; the run stops, and a healthy rerun completes", async () => {
  const db = new FakeDb({ failOn: (text, params) => text === INSERT_COMMIT_SQL && params[1] === SHA(2) });
  const spool = new FakeSpool();
  await assert.rejects(run(github(), db, spool), /db boom/);
  assert.equal(Object.keys(db.state.commits).length, 0, "the whole page was rolled back");
  assert.equal(db.calls.at(-1), "ROLLBACK");

  const healthy = new FakeDb();
  healthy.state = db.state;
  const summary = await run(github(), healthy, spool);
  assert.equal(summary.commits.inserted, 3);
  assert.equal(spool.lines.length, 3, "the spool is keyed by sha, so the earlier lines are not duplicated");
});

test("--limit caps commits, issues and pull requests per repository", async () => {
  const gh = github({ commitPages: [[ghCommit(1), ghCommit(2)], [ghCommit(3)]], issuePages: [[ghIssue(1), ghIssue(2), ghIssue(3)]], pullPages: [[ghPull(10), ghPull(11), ghPull(12)]] });
  const summary = await run(gh, new FakeDb(), new FakeSpool(), { limit: 2 });
  assert.deepEqual([summary.commits.listed, summary.commits.inserted, summary.issues.listed, summary.pulls.listed], [2, 2, 2, 2]);
  assert.ok(!gh.calls.includes(`${base}/commits/${SHA(3)}?per_page=300`));
});

test("--limit smaller than a page stops in the middle of the page, before any extra request", async () => {
  const gh = github({ commitPages: [[ghCommit(1), ghCommit(2), ghCommit(3)]] });
  const summary = await run(gh, new FakeDb(), new FakeSpool(), { limit: 1 });
  assert.deepEqual([summary.commits.listed, summary.commits.fetched, summary.commits.inserted], [1, 1, 1]);
  assert.ok(gh.calls.includes(`${base}/commits/${SHA(1)}?per_page=300`));
  assert.ok(!gh.calls.includes(`${base}/commits/${SHA(2)}?per_page=300`), "no detail request beyond the limit");
});

test("an empty repository (409 on the commit list) is not an error", async () => {
  const gh = github({ commitPages: [], errors: { [COMMITS]: new GitHubError("conflict", 409) }, issuePages: [[ghIssue(1)]] });
  const summary = await run(gh, new FakeDb(), new FakeSpool());
  assert.deepEqual(summary.commits, { listed: 0, fetched: 0, inserted: 0, alreadyStored: 0, invalid: 0 });
  assert.equal(summary.issues.upserted, 1);
});

test("other commit-list errors are not swallowed", async () => {
  const gh = github({ commitPages: [], errors: { [COMMITS]: new GitHubError("nope", 404) } });
  await assert.rejects(run(gh, new FakeDb(), new FakeSpool()), (err: GitHubError) => err.status === 404);
});

test("malformed commit entries are counted and never become request paths", async () => {
  const gh = github({ commitPages: [[ghCommit(1), { sha: "../../etc/passwd" }, { sha: 5 }, "junk", ghCommit(2)]] });
  const summary = await run(gh, new FakeDb(), new FakeSpool());
  assert.deepEqual([summary.commits.inserted, summary.commits.invalid], [2, 3]);
  assert.ok(gh.calls.every((c) => !c.includes("passwd")));
});

test("a commit with a date GitHub gives no usable value for is counted invalid, not inserted", async () => {
  const gh = github({ commitPages: [[ghCommit(1)]], details: { 1: { data: { ...ghDetail(1), commit: { message: "no dates" } } } } });
  const db = new FakeDb();
  const summary = await run(gh, db, new FakeSpool());
  assert.deepEqual([summary.commits.fetched, summary.commits.inserted, summary.commits.invalid], [1, 0, 1]);
  assert.equal(Object.keys(db.state.commits).length, 0);
});

test("a commit with more than 300 files is read across pages", async () => {
  const filesA = Array.from({ length: 300 }, (_, i) => ({ filename: `a${i}`, status: "added", additions: 1, deletions: 0, changes: 1 }));
  const filesB = [{ filename: "b0", status: "added", additions: 1, deletions: 0, changes: 1 }];
  const next = "https://api.github.com/repos/octo/widgets/commits/x?page=2";
  const gh = github({ commitPages: [[ghCommit(1)]], details: { 1: { data: ghDetail(1, filesA), link: { next } } } });
  (gh as unknown as { routes: Record<string, Route> }).routes[next] = { data: { files: filesB } };
  const db = new FakeDb();
  const spool = new FakeSpool();
  await run(gh, db, spool);
  assert.equal(Object.values(db.state.commits)[0].filesChanged, 301);
  assert.equal(spool.lines[0].files.length, 301);
});

test("an existing project and repository are reused, not duplicated", async () => {
  const db = new FakeDb();
  db.state.projects[SLUG] = "99";
  const first = github({ commitPages: [] });
  await run(first, db, new FakeSpool());
  assert.deepEqual(Object.values(db.state.repos).map((r) => r.projectId), ["99"]);
  await run(github({ commitPages: [] }), db, new FakeSpool());
  assert.equal(Object.keys(db.state.repos).length, 1);
  assert.equal(Object.keys(db.state.projects).length, 1);
});

test("nothing in the data path ever issues a destructive statement", async () => {
  const db = new FakeDb();
  await run(github({ issuePages: [[ghIssue(1)]], pullPages: [[ghPull(2)]] }), db, new FakeSpool());
  assert.ok(db.calls.every((sql) => !/\b(DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(sql)));
});

// ---- privacy: no contributor names or emails are persisted; emails in text are redacted ----

const NAME = "Octo Cat"; // the git author name in the ghCommit fixture
const EMAIL = "octo@example.test"; // the git author email in the ghCommit fixture

test("redactEmails replaces addresses and keeps the surrounding text and trailer structure", () => {
  assert.equal(redactEmails("write to a.b+c@example.com now"), "write to [email redacted] now");
  assert.equal(
    redactEmails("Fix bug\n\nCo-authored-by: Jane Doe <jane@example.org>\nSigned-off-by: Joe <12345+joe@users.noreply.github.com>"),
    "Fix bug\n\nCo-authored-by: Jane Doe <[email redacted]>\nSigned-off-by: Joe <[email redacted]>",
  );
  assert.equal(redactEmails("a@b.co,c@d.org;e@f.io"), "[email redacted],[email redacted];[email redacted]");
  assert.equal(redactEmails("Mail me at USER@Sub.Example.COM."), "Mail me at [email redacted].", "trailing sentence punctuation is kept");
  assert.equal(redactEmails("(x@y.zz)"), "([email redacted])");
});

test("redactEmails leaves things that are not email addresses alone", () => {
  for (const same of ["", "no at sign", "ping @octocat please", "v@2.0", "a @ b", "foo@bar", "foo@bar.", "foo@.com", "@example.com", "@@", "x@1.2", "use decorator @app.route('/x')", "a@b.c"]) {
    assert.equal(redactEmails(same), same, JSON.stringify(same));
  }
});

test("redactEmails is idempotent and never matches its own placeholder", () => {
  const once = redactEmails("mail a@b.com and c@d.org");
  assert.equal(redactEmails(once), once);
  assert.equal(once, "mail [email redacted] and [email redacted]");
});

test("redactEmails runs in linear time on hostile input", () => {
  const started = Date.now();
  redactEmails("a".repeat(300_000));
  redactEmails("@".repeat(300_000));
  redactEmails("a@".repeat(150_000));
  redactEmails(("a".repeat(1000) + "@" + "b".repeat(1000) + ".").repeat(100));
  redactEmails("a@b" + ".c".repeat(100_000));
  assert.ok(Date.now() - started < 3000, "must not backtrack");
});

test("an address followed directly by more characters is still redacted (found by differential fuzzing)", () => {
  assert.equal(redactEmails("x@a.aaZ-1-bac"), "[email redacted]-1-bac");
  assert.equal(redactEmails("me@example.org1"), "[email redacted]1");
  assert.equal(redactEmails("mail a@b.com-foo"), "mail [email redacted]-foo");
  assert.equal(redactEmails("(a@b.co-)"), "([email redacted]-)");
  assert.equal(redactEmails("a@b.com..."), "[email redacted]...");
  assert.equal(redactEmails("a@b.c.dd.ee9"), "[email redacted]9");
});

test("redactEmails agrees with a plain regex on 60,000 seeded random strings", () => {
  const reference = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const alphabet = ["a", "b", "Z", "1", ".", ".", "@", "@", "-", "_", "+", "%", " ", "<", ">", "c", "o", "m"];
  let seed = 12345;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 60_000; i++) {
    let text = "";
    for (let k = Math.floor(next() * 28); k > 0; k--) text += alphabet[Math.floor(next() * alphabet.length)];
    const expected = text.replace(reference, "[email redacted]");
    if (redactEmails(text) !== expected) assert.fail(`differs from the reference for ${JSON.stringify(text)}`);
  }
});

test("redactEmails stays linear on the shape that would make a naive scan quadratic", () => {
  const started = Date.now();
  redactEmails("a@x.." + "bb.".repeat(100_000));
  redactEmails("a@" + "b.".repeat(150_000) + "9");
  redactEmails(("a@b." + "x".repeat(50) + "-").repeat(5_000));
  assert.ok(Date.now() - started < 3000, "must not go quadratic");
});

test("every stored free-text field is redacted: commit message, issue and PR title/body, repository description", () => {
  const dirty = "reach me at someone@example.net";
  const clean = "reach me at [email redacted]";
  const commit = mapCommit({ ...ghDetail(1), commit: { ...ghCommit(1).commit, message: dirty } }, [], noUsers);
  assert.equal(commit?.message, clean);
  const issue = mapIssue(ghIssue(1, { title: dirty, body: dirty }), noUsers);
  assert.deepEqual([issue?.title, issue?.body], [clean, clean]);
  const pull = mapPull(ghPull(1, { title: dirty, body: dirty }), noUsers);
  assert.deepEqual([pull?.title, pull?.description], [clean, clean]);
  assert.equal(mapRepository({ ...REPO_META, description: dirty }).description, clean);
  assert.equal(mapIssue(ghIssue(2, { body: null }), noUsers)?.body, null, "null stays null");
  assert.equal(mapCommit({ ...ghDetail(2), commit: { ...ghCommit(2).commit, message: "no\u0000 a\u0000@b.com" } }, [], noUsers)?.message, "no [email redacted]", "NUL bytes are removed before redaction");
});

test("the commit row can carry neither an author name nor an author email", () => {
  const row = mapCommit(ghDetail(1), mapFiles(DEFAULT_FILES), new Map([["octocat", "7"]]));
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ["additions", "authorId", "authorLogin", "committedAt", "deletions", "filesChanged", "message", "sha"]);
  const text = JSON.stringify(row);
  assert.ok(!text.includes(NAME) && !text.includes(EMAIL), "neither the git name nor the git email survives mapping");
});

test("missing author metadata is fine: no account, no name, no login, no email", () => {
  const bare = { sha: SHA(9), commit: { committer: { date: "2026-03-03T00:00:00Z" }, message: "anonymous" }, stats: { additions: 1, deletions: 0 } };
  const row = mapCommit(bare, [], new Map([["octocat", "7"]]));
  assert.deepEqual([row?.authorId, row?.authorLogin, row?.message], [null, null, "anonymous"]);
  const unlinked = mapCommit({ ...ghDetail(3), author: null }, [], noUsers); // a git author with no GitHub account
  assert.deepEqual([unlinked?.authorId, unlinked?.authorLogin], [null, null]);
  const partial = mapCommit({ ...ghDetail(4), commit: { committer: { date: "2026-01-01T00:00:00Z" }, message: "m", author: {} } }, [], noUsers);
  assert.ok(partial);
});

test("an unexpected-looking login is not written to the spool", () => {
  for (const bad of ["has space", "a/b", "x".repeat(60), "evil\nnewline", "<script>", "", "-lead", "o'brien"]) {
    assert.equal(mapCommit({ ...ghDetail(1), author: { login: bad } }, [], noUsers)?.authorLogin, null, JSON.stringify(bad));
  }
  for (const ok of ["octocat", "Octo-Cat", "dependabot[bot]", "a1"]) {
    assert.equal(mapCommit({ ...ghDetail(1), author: { login: ok } }, [], noUsers)?.authorLogin, ok);
  }
});

test("a run persists no contributor names or emails and spools only the public login", async () => {
  const gh = github({
    meta: { ...REPO_META, description: `Maintained by the team, contact ${EMAIL} or me@example.test` },
    commitPages: [[ghCommit(1), ghCommit(2)]],
    details: {
      1: { data: ghDetail(1) },
      2: { data: { ...ghDetail(2), author: null, commit: { ...ghCommit(2).commit, message: `thanks!\n\nCo-authored-by: Someone <${EMAIL}>` } } }, // no GitHub account
    },
    issuePages: [[ghIssue(1, { title: "ask me@example.test", body: `contact ${EMAIL}` })]],
    pullPages: [[ghPull(3, { title: "t", body: `cc ${EMAIL}` })]],
  });
  const db = new FakeDb();
  const spool = new FakeSpool();
  const summary = await run(gh, db, spool, { userIds: new Map([["octocat", "7"]]) });
  assert.equal(summary.commits.inserted, 2);

  assert.deepEqual(db.commitParamCounts, [8, 8], "no name or email parameter is ever sent");
  // The repository description reaches the project insert already redacted.
  assert.equal(db.projectInserts.length, 1);
  assert.deepEqual(db.projectInserts[0], [SLUG, "Maintained by the team, contact [email redacted] or [email redacted]", "active"]);
  assert.ok(!JSON.stringify(db.projectInserts).includes(EMAIL) && !JSON.stringify(db.projectInserts).includes("me@example.test"));
  for (const row of Object.values(db.state.commits)) assert.deepEqual(Object.keys(row).sort(), ["additions", "authorId", "committedAt", "deletions", "filesChanged", "message", "repositoryId", "sha"]);
  const stored = JSON.stringify(db.state);
  assert.ok(!stored.includes(NAME), "the git author name was not stored");
  assert.ok(!stored.includes(EMAIL), "no email survives anywhere in what was stored (author fields, messages, issues, pull requests)");
  assert.ok(!stored.includes("me@example.test"));
  assert.ok(stored.includes("[email redacted]"));
  assert.ok(stored.includes("Co-authored-by: Someone <[email redacted]>"), "trailer structure is preserved");

  assert.deepEqual(spool.lines.map((l) => [l.sha, l.author_login]), [[SHA(1), "OctoCat"], [SHA(2), null]], "login where GitHub provides one, null otherwise");
  assert.deepEqual(Object.keys(spool.lines[0]).sort(), ["author_login", "committed_at", "files", "repo", "sha"]);
  const spooled = JSON.stringify(spool.lines);
  assert.ok(!spooled.includes(NAME) && !spooled.includes(EMAIL) && !spooled.includes("@"), "the spool carries no name or email");
});
