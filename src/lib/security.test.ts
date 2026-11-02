// P2-16: regression tests for injected SQL, forged roles and unsafe configuration. They run against the real
// modules; nothing here needs a database. Database-backed behaviour is not covered (see the final report).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT } from "jose";
import { getSessionKey, signSession, verifySession } from "./session-token";
import { parseLoginInput } from "./login-input";
import { ISSUE_STATUSES, parseId, parseIssueForm } from "./issue-input";
import { PR_ACTIONS, PR_TRANSITIONS, isPullRequestStatus, parsePullRequestAction } from "./pull-request-input";
import { parsePage } from "./format";
import { countIssues, createIssue, getIssue, listIssues, updateIssue, CREATE_ISSUE_SQL, GET_ISSUE_SQL, LIST_ISSUES_SQL, UPDATE_ISSUE_SQL } from "./issues";
import {
  APPROVE_PULL_REQUEST_SQL, GET_PULL_REQUEST_SQL, LIST_PULL_REQUESTS_SQL, MERGE_PULL_REQUEST_SQL, PULL_REQUEST_STATE_SQL, TRANSITION_PULL_REQUEST_SQL,
  countPullRequests, getPullRequest, listPullRequests, transitionPullRequest,
} from "./pull-requests";
import { MEMBER_CONTRIBUTIONS_SQL, getMemberEvidence, listMemberContributions } from "./contributions";

const PAYLOADS = [
  "1; DROP TABLE users; --",
  "' OR '1'='1",
  "1 OR 1=1",
  "1' UNION SELECT password_hash FROM users --",
  "\"; DELETE FROM issues; --",
  "$1; SELECT pg_sleep(10)",
  "1\u0000; DROP TABLE users",
  "９９９", // full-width digits
  "1e3",
  " 1",
  "1\n",
  "0x1",
];

// ---------------------------------------------------------------- injection: values are rejected before the database

test("injection payloads are not accepted as ids, statuses, actions or page numbers", () => {
  for (const p of PAYLOADS) {
    assert.equal(parseId(p), null, `parseId ${JSON.stringify(p)}`);
    assert.equal(isPullRequestStatus(p), false, `status ${JSON.stringify(p)}`);
    assert.equal((ISSUE_STATUSES as readonly string[]).includes(p), false);
    assert.equal(parsePullRequestAction(p), null, `action ${JSON.stringify(p)}`);
    assert.equal(parsePage(p), 1, `page ${JSON.stringify(p)}`);
  }
  assert.equal(parseId("1; DROP TABLE users"), null);
  assert.equal(parseId("99999999999999999999"), null); // beyond bigint
  assert.equal(parseId("-1"), null);
  assert.equal(parseId("0"), null);
});

test("the issue form rejects injected status, priority and repository values", () => {
  for (const p of PAYLOADS) {
    const bad = parseIssueForm(new Map([["repositoryId", p], ["title", "t"], ["status", p], ["priority", p]]), { requireRepository: true });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.errors.repositoryId && bad.errors.status && bad.errors.priority, JSON.stringify(p));
    }
  }
});

// ---------------------------------------------------------------- injection: free text only ever travels as a parameter

type Call = { text: string; params: readonly unknown[] };
const recorder = (rows: unknown[] = []) => {
  const calls: Call[] = [];
  const run = (async (text: string, params: readonly unknown[]) => { calls.push({ text, params }); return rows; }) as never;
  return { calls, run };
};

test("free text in titles and bodies is bound as a parameter, and the SQL text stays the fixed constant", async () => {
  for (const p of PAYLOADS) {
    const a = recorder([{ id: "1", mirrored: false }]);
    await createIssue("4", { title: p, body: p, status: "open", priority: "low" }, "9", a.run);
    assert.equal(a.calls[0].text, CREATE_ISSUE_SQL);
    assert.ok(a.calls[0].params.includes(p));

    const b = recorder([{ id: "1", mirrored: false }]);
    await updateIssue("5", { title: p, body: p, status: "open", priority: "low" }, "9", b.run);
    assert.equal(b.calls[0].text, UPDATE_ISSUE_SQL);
    assert.deepEqual(b.calls[0].params.slice(1, 3), [p, p]);
  }
});

test("hostile filter, id and actor values reach every read and write only as parameters", async () => {
  for (const p of PAYLOADS) {
    const checks: [string, string, (run: never) => Promise<unknown>][] = [
      [LIST_ISSUES_SQL, "listIssues", (run) => listIssues({ repositoryId: p, status: p }, 1, p, run)],
      [GET_ISSUE_SQL, "getIssue", (run) => getIssue(p, p, run)],
      [LIST_PULL_REQUESTS_SQL, "listPullRequests", (run) => listPullRequests({ repositoryId: p, status: p }, 1, 25, p, run)],
      [GET_PULL_REQUEST_SQL, "getPullRequest", (run) => getPullRequest(p, p, run)],
      [MEMBER_CONTRIBUTIONS_SQL, "listMemberContributions", (run) => listMemberContributions(p, p, run)],
      [MEMBER_CONTRIBUTIONS_SQL, "getMemberEvidence", (run) => getMemberEvidence(p, p, p, run)],
    ];
    for (const [sql, name, call] of checks) {
      const r = recorder();
      await call(r.run);
      assert.equal(r.calls[0].text, sql, name);
      assert.ok(r.calls[0].params.includes(p), `${name} binds ${JSON.stringify(p)}`);
      // Short numeric look-alikes such as " 1" are legitimate substrings of any SQL text, so only syntax-bearing payloads are checked.
      if (/[;'"]/.test(p)) for (const c of r.calls) assert.ok(!c.text.includes(p), `${name} SQL text must not contain the payload`);
    }
    // Every pull request action takes its own path to the database; the hostile id and actor are parameters on each.
    const closeRun = recorder([{ id: "1", mirrored: false, status: "open" }]);
    await transitionPullRequest(p, "close", p, closeRun.run);
    assert.equal(closeRun.calls[0].text, TRANSITION_PULL_REQUEST_SQL);
    assert.deepEqual([closeRun.calls[0].params[0], closeRun.calls[0].params[3]], [p, p]);
    assert.ok(Array.isArray(closeRun.calls[0].params[2])); // allowed statuses are an array parameter, not SQL text

    const approveRun = recorder([{ reviewed: "1", updated: "1" }]);
    await transitionPullRequest(p, "approve", p, approveRun.run);
    assert.equal(approveRun.calls[0].text, APPROVE_PULL_REQUEST_SQL);
    assert.deepEqual(approveRun.calls[0].params, [p, p]);

    const mergeRun = recorder([{ id: null, mirrored: false, status: "approved" }]);
    await transitionPullRequest(p, "merge", p, mergeRun.run);
    assert.deepEqual(mergeRun.calls.map((c) => c.text), [PULL_REQUEST_STATE_SQL, MERGE_PULL_REQUEST_SQL]);
    assert.deepEqual(mergeRun.calls[1].params, [p, p]);
    if (/[;'"]/.test(p)) for (const r of [closeRun, approveRun, mergeRun]) for (const c of r.calls) assert.ok(!c.text.includes(p));
  }
  const c = recorder([{ n: 1 }]);
  await countIssues({ repositoryId: "1' OR '1'='1", status: null }, "1' OR '1'='1", c.run);
  await countPullRequests({ repositoryId: "1' OR '1'='1", status: null }, "1' OR '1'='1", c.run);
  assert.ok(c.calls.every((x) => !x.text.includes("OR '1'='1")));
});

test("login: the email is only ever a parameter value and extra fields such as role are dropped", () => {
  const parsed = parseLoginInput({ email: "  A@B.C' OR '1'='1 ", password: "p", role: "mentor", isAdmin: true, id: "1" });
  assert.deepEqual(parsed, { email: "a@b.c' or '1'='1", password: "p" });
  assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["email", "password"]);
  const route = readFileSync(join(process.cwd(), "src/app/api/auth/login/route.ts"), "utf8");
  assert.match(route, /"SELECT id, email, full_name, password_hash, role FROM users WHERE email = \$1",\s*\[input\.email\]/);
});

// ---------------------------------------------------------------- injection: static guard over the whole code base

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === ".next" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
const files = [...sourceFiles(join(process.cwd(), "src")), ...sourceFiles(join(process.cwd(), "scripts"))];

// The only things that may be spliced into a SQL template: fixed fragments defined in the same module.
const ALLOWED_FRAGMENTS = new Set(["ISSUE_COLUMNS", "ISSUE_FROM", "PR_COLUMNS", "PR_FROM", "PR_WHERE"]);
// The shared access fragments of src/lib/project-access.ts, called with a literal placeholder and a literal column name.
// Nothing else may appear in the call, and the helpers themselves throw unless both arguments have exactly that shape.
const ACCESS_FRAGMENT_CALL = /^(?:managerSql|participantSql)\("\$[1-9]\d?", "[a-z]{1,12}\.[a-z_]{1,24}"\)$/;
const isAllowedHole = (hole: string) => ALLOWED_FRAGMENTS.has(hole) || ACCESS_FRAGMENT_CALL.test(hole);
// Inside project-access.ts itself the builders splice the project column and the viewer cast. That is allowed there only,
// and only for these two names, because both builders call checked(viewer, projectId) first (pinned in the test below).
const ACCESS_HELPER_FILE = join(process.cwd(), "src", "lib", "project-access.ts");
const ACCESS_HELPER_HOLES = new Set(["projectId", "v"]);
// pull-requests.ts builds its WHERE clause in a local function, prWhere(viewer). Its only SQL-bearing hole is the shared
// participantSql(viewer, "r.project_id"): the column is a literal and participantSql throws unless `viewer` is a $n
// placeholder, and every caller passes one as a literal, prWhere("$5"). Allowed in that file only (pinned by the test below).
const PULL_REQUESTS_FILE = join(process.cwd(), "src", "lib", "pull-requests.ts");
const PR_WHERE_CALL = /^prWhere\("\$[1-9]\d?"\)$/;
const PR_WHERE_BODY_HOLE = 'participantSql(viewer, "r.project_id")';

// Words that start a statement or continue one (the SQL here is upper case, so the match is case-sensitive and ordinary
// prose is not affected). A template that has one of them, or a $n placeholder, is SQL, including a fragment that begins
// at WHERE, AND or ORDER BY rather than at SELECT.
const SQL_WORDS = "SELECT|INSERT|UPDATE|DELETE|WITH|WHERE|FROM|JOIN|ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|VALUES|RETURNING|ON\\s+CONFLICT|UNION|SET|AND|OR";
const SQL_FRAGMENT = new RegExp(`\\b(?:${SQL_WORDS})\\b|(?<![\\w$])\\$[1-9]\\d?\\b`);
// A SQL string literal joined to a non-literal with + would be the other way to build a query from input: "WHERE x = " + y,
// and the reverse order, y + " WHERE x".
const SQL_CONCAT_RIGHT = new RegExp(`"((?:${SQL_WORDS})\\b[^"]*)"\\s*\\+\\s*([^\\s"\`][^\\n]*)`, "g");
const SQL_CONCAT_LEFT = new RegExp(`([\\w)\\]]\\s*\\+\\s*"\\s*(?:${SQL_WORDS})\\b[^\\n]{0,30})`, "g");

function isAllowedSplice(file: string, hole: string): boolean {
  return (
    isAllowedHole(hole) ||
    (file === ACCESS_HELPER_FILE && ACCESS_HELPER_HOLES.has(hole)) ||
    (file === PULL_REQUESTS_FILE && (PR_WHERE_CALL.test(hole) || hole === PR_WHERE_BODY_HOLE))
  );
}

// Every way this file's text puts something other than an allowed fragment into SQL. Empty means clean.
function sqlSplices(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    if (!SQL_FRAGMENT.test(m[1])) continue;
    for (const hole of m[1].matchAll(/\$\{([^}]*)\}/g)) {
      if (!isAllowedSplice(file, hole[1].trim())) problems.push(`${file}: \${${hole[1]}} inside a SQL template`);
    }
  }
  for (const m of text.matchAll(SQL_CONCAT_RIGHT)) problems.push(`${file}: SQL string concatenated with ${m[2].slice(0, 40)}`);
  for (const m of text.matchAll(SQL_CONCAT_LEFT)) problems.push(`${file}: a value concatenated into SQL near ${m[1].slice(0, 50)}`);
  return problems;
}

test("no source file splices a variable into SQL, except the fixed column and clause fragments", () => {
  assert.ok(files.length > 10);
  assert.deepEqual(files.flatMap((file) => sqlSplices(file, readFileSync(file, "utf8"))), []);
});

// ---- the scanner itself: it must accept what the code base really does and reject what it must not

const CONTRIBUTIONS_FILE = join(process.cwd(), "src", "lib", "contributions.ts");
const MEMBER_HOLE = '${managerSql("$3", "m.project_id")}';
const LIST_HOLE = '${participantSql("$1", "p.id")}';

test("scanner: the member and project-list queries are accepted as they are, and their access fragments are really in the source", () => {
  const src = readFileSync(CONTRIBUTIONS_FILE, "utf8");
  assert.ok(src.includes(MEMBER_HOLE) && src.includes(LIST_HOLE), "the access fragments this test mutates are present");
  assert.deepEqual(sqlSplices(CONTRIBUTIONS_FILE, src), []);
});

test("scanner: an arbitrary interpolation in the member query, which begins at WHERE, is rejected", () => {
  const src = readFileSync(CONTRIBUTIONS_FILE, "utf8");
  const bad = src.replace(MEMBER_HOLE, "${evil}");
  assert.notEqual(bad, src);
  assert.deepEqual(sqlSplices(CONTRIBUTIONS_FILE, bad).map((p) => p.replace(CONTRIBUTIONS_FILE, "")), [": ${evil} inside a SQL template"]);
  // Right shape, wrong arguments: a variable placeholder, a variable column, or a different builder.
  for (const hole of ['${managerSql(viewer, "m.project_id")}', '${managerSql("$3", col)}', '${evilSql("$3", "m.project_id")}']) {
    assert.equal(sqlSplices(CONTRIBUTIONS_FILE, src.replace(MEMBER_HOLE, hole)).length, 1, hole);
  }
});

test("scanner: an arbitrary interpolation in LIST_PROJECTS_SQL is rejected", () => {
  const src = readFileSync(CONTRIBUTIONS_FILE, "utf8");
  const bad = src.replace(LIST_HOLE, "${evil}");
  assert.notEqual(bad, src);
  assert.equal(sqlSplices(CONTRIBUTIONS_FILE, bad).length, 1);
});

test("scanner: fragments that do not start at SELECT are inspected, and legitimate fragments and ordinary text still pass", () => {
  const other = join(process.cwd(), "src", "lib", "other.ts");
  for (const bad of ["WHERE ${x}", "AND ${x}", "OR ${x}", "ORDER BY ${x}", "GROUP BY ${x}", "LIMIT ${x}", "OFFSET ${x}", "JOIN ${x} ON a = b", "a = $1 ${x}", "VALUES (${x})", "SET a = ${x}", "ON CONFLICT ${x}", "FROM ${x}"]) {
    assert.equal(sqlSplices(other, `const q = \`${bad}\`;`).length, 1, bad);
  }
  for (const ok of ['WHERE ${managerSql("$3", "m.project_id")}', 'AND ${participantSql("$5", "r.project_id")} ORDER BY x', "SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} WHERE a = $1", "WHERE a = $1"]) {
    assert.deepEqual(sqlSplices(other, `const q = \`${ok}\`;`), [], ok);
  }
  for (const prose of ["Hello ${name}", "${n} items from the list", "updated ${when} and set by ${who}", "/api/issues/${id}/edit"]) {
    assert.deepEqual(sqlSplices(other, `const m = \`${prose}\`;`), [], prose); // lower case or no SQL word: not SQL
  }
});

test("scanner: concatenation into SQL is rejected in both orders, while joining literals is fine", () => {
  const other = join(process.cwd(), "src", "lib", "other.ts");
  for (const bad of ['const q = "WHERE a = " + x;', 'const q = "AND a = " + x;', 'const q = x + " WHERE a = 1";', 'const q = f(x) + " ORDER BY a";', 'const q = "SELECT a " +\n  cols;']) {
    assert.ok(sqlSplices(other, bad).length >= 1, bad);
  }
  for (const ok of ['const q = "SELECT a " +\n  "FROM b WHERE c = $1";', 'const q = "WHERE a = $1" + `${managerSql("$3", "m.project_id")}`;']) {
    assert.deepEqual(sqlSplices(other, ok), [], ok);
  }
});

test("scanner: the pull-request WHERE builder is allowed in pull-requests.ts only, and only in its exact shape", () => {
  const other = join(process.cwd(), "src", "lib", "other.ts");
  const body = 'const prWhere = (viewer: string) => `WHERE a = $1 AND ${participantSql(viewer, "r.project_id")}`;';
  const use = 'const q = `SELECT 1 FROM t ${prWhere("$5")} LIMIT $3`;';
  assert.deepEqual(sqlSplices(PULL_REQUESTS_FILE, body), []);
  assert.deepEqual(sqlSplices(PULL_REQUESTS_FILE, use), []);
  assert.equal(sqlSplices(other, body).length, 1, "the same builder elsewhere");
  assert.equal(sqlSplices(other, use).length, 1, "the same call elsewhere");
  for (const bad of ['`WHERE ${prWhere(userInput)}`', '`WHERE ${prWhere("$5; DROP TABLE x")}`', '`WHERE ${prWhere("$5") + extra}`', '`WHERE ${participantSql(viewer, col)}`', '`WHERE ${participantSql(viewer, "r.project_id") + x}`', '`WHERE ${managerSql(viewer, "r.project_id")}`']) {
    assert.equal(sqlSplices(PULL_REQUESTS_FILE, `const q = ${bad};`).length, 1, bad);
  }
});

// Some branches have no pull-requests.ts, or an older one without prWhere: nothing uses the allowance there, so this pin is
// reported as skipped. It runs wherever prWhere exists.
const pullRequestsSource = (() => { try { return readFileSync(PULL_REQUESTS_FILE, "utf8"); } catch { return null; } })();
const noPrWhere = pullRequestsSource === null ? "src/lib/pull-requests.ts is not present on this branch" : !pullRequestsSource.includes("prWhere") && "src/lib/pull-requests.ts has no prWhere on this branch";

test("scanner: prWhere is defined once, only wraps participantSql with a literal column, and is only called with literal placeholders", { skip: noPrWhere }, () => {
  const text = pullRequestsSource as string;
  const definitions = [...text.matchAll(/const prWhere = \(viewer: string\) =>\s*(`[^`]*`);/g)];
  assert.equal(definitions.length, 1, "exactly one definition, taking a string viewer");
  assert.deepEqual([...definitions[0][1].matchAll(/\$\{([^}]*)\}/g)].map((h) => h[1].trim()), [PR_WHERE_BODY_HOLE]);
  const calls = [...text.matchAll(/prWhere\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 1);
  for (const call of calls) assert.match(call, PR_WHERE_CALL, `prWhere may only be called with a literal placeholder: ${call}`);
});

test("only the shared access fragments, called with literal arguments, may be spliced into SQL besides the fixed fragments", () => {
  for (const ok of ['managerSql("$3", "m.project_id")', 'participantSql("$1", "p.id")', "ISSUE_COLUMNS"]) assert.equal(isAllowedHole(ok), true, ok);
  for (const bad of ["managerSql(viewer, col)", 'managerSql("$3", col)', 'managerSql("$3", "m.project_id") + x', 'managerSql("$3; DROP", "m.project_id")', 'managerSql("$3", "m.project_id OR 1=1")', "userInput", "otherSql()"]) {
    assert.equal(isAllowedHole(bad), false, bad);
  }
});

test("both shared access builders validate the placeholder and the column before they build any SQL", () => {
  const text = readFileSync(ACCESS_HELPER_FILE, "utf8");
  for (const fn of ["participantSql", "managerSql"]) {
    assert.match(text, new RegExp(`export function ${fn}\\(viewer: string, projectId: string\\): string \\{\\s*checked\\(viewer, projectId\\);`), fn);
  }
  assert.match(text, /const PLACEHOLDER = \/\^\\\$\[1-9\]\\d\?\$\/;/);
  assert.match(text, /const COLUMN = \/\^\[a-z\]\{1,12\}\\\.\[a-z_\]\{1,24\}\$\/;/);
});

// The one computed-SQL call that is allowed: the ingestion helper in scripts/ingest-data.ts runs
// `deps.db.query(opts.sql, opts.params(opts.repoId, row))`. It is safe because `opts.sql` is never built from
// input: the helper has exactly two callers and they pass the constants UPSERT_ISSUE_SQL and UPSERT_PULL_SQL
// (pinned by the test below). The exception compares the COMPLETE call, from its receiver to its closing parenthesis,
// with this one expression (whitespace aside). Any other receiver, a different or extra argument, an extra expression
// inside an argument, or the same call in another file still fails the check.
const INGEST_FILE = join(process.cwd(), "scripts", "ingest-data.ts");
const APPROVED_INGEST_CALL = "deps.db.query(opts.sql, opts.params(opts.repoId, row))";
const APPROVED_INGEST_SQL = ["UPSERT_ISSUE_SQL", "UPSERT_PULL_SQL"];
// The approved call as an anchored pattern: its tokens exactly, with optional whitespace only between tokens (never inside one).
const APPROVED_INGEST_PATTERN = new RegExp(
  `^${(APPROVED_INGEST_CALL.match(/[A-Za-z_$][\w$]*|[^\sA-Za-z_$]/g) ?? []).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")}$`,
);
const isApprovedDynamicQuery = (file: string, call: string | null) => file === INGEST_FILE && call !== null && APPROVED_INGEST_PATTERN.test(call);

const DATABASE_CALL = /\b(?:query|client\.query|db\.query|run)(?:<[^>(]*>)?\(\s*/g;

// The complete text of the call matched at `index`: from its receiver (`deps.`, only when it is exactly that token) to the
// parenthesis that closes it. Parentheses inside string and template literals do not count. Null if they never balance.
function callExpression(text: string, index: number, matched: string): string | null {
  let depth = 0;
  for (let i = index + matched.indexOf("("); i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      const receiver = /(?:^|[^\w$.])deps\.$/.test(text.slice(Math.max(0, index - 6), index));
      return text.slice(receiver ? index - 5 : index, i + 1);
    }
  }
  return null;
}

// Database calls whose first argument is neither a fixed string, a *_SQL constant, nor the one approved call.
function unexpectedQueryArguments(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(DATABASE_CALL)) {
    const rest = text.slice(m.index + m[0].length);
    const ok = /^"(?:[^"\\\n]|\\.)*"/.test(rest) || /^[A-Z][A-Z0-9_]*_SQL\b/.test(rest) || /^\)/.test(rest);
    // `run(` is also a name used for parameters of the data-access functions; only calls with a first argument matter.
    if (!ok && /^[A-Za-z_]/.test(rest) && /^(?:text|sql|q)\b/.test(rest)) continue;
    if (!ok && !isApprovedDynamicQuery(file, callExpression(text, m.index, m[0]))) problems.push(`${file}: unexpected first argument near ${JSON.stringify(rest.slice(0, 50))}`);
  }
  return problems;
}

test("every database call passes a fixed SQL string or a *_SQL constant, never a computed one", () => {
  for (const file of files) {
    if (file.endsWith("src/lib/db.ts")) continue; // the helper itself forwards `text`
    assert.deepEqual(unexpectedQueryArguments(file, readFileSync(file, "utf8")), []);
  }
});

test("the ingestion exception accepts only the complete approved call, and only in scripts/ingest-data.ts", () => {
  const ok = (call: string | null) => isApprovedDynamicQuery(INGEST_FILE, call);
  assert.equal(ok(APPROVED_INGEST_CALL), true);
  assert.equal(ok("deps.db.query(\n    opts.sql,\n    opts.params(opts.repoId, row)\n  )"), true, "line breaks and spacing do not matter");
  for (const file of [join(process.cwd(), "src", "lib", "issues.ts"), join(process.cwd(), "scripts", "other.ts"), join(process.cwd(), "src", "lib", "db.ts")]) {
    assert.equal(isApprovedDynamicQuery(file, APPROVED_INGEST_CALL), false, file);
  }
  const rejected: [string, string][] = [
    ["trailing argument", "deps.db.query(opts.sql, opts.params(opts.repoId, row), extra)"],
    ["trailing array argument", "deps.db.query(opts.sql, opts.params(opts.repoId, row), [userInput])"],
    ["trailing comma", "deps.db.query(opts.sql, opts.params(opts.repoId, row),)"],
    ["missing second argument", "deps.db.query(opts.sql)"],
    ["different row", "deps.db.query(opts.sql, opts.params(opts.repoId, other))"],
    ["swapped parameters", "deps.db.query(opts.sql, opts.params(row, opts.repoId))"],
    ["fewer parameters", "deps.db.query(opts.sql, opts.params(opts.repoId))"],
    ["extra parameter", "deps.db.query(opts.sql, opts.params(opts.repoId, row, extra))"],
    ["params not called", "deps.db.query(opts.sql, opts.params)"],
    ["literal parameters", "deps.db.query(opts.sql, [userInput])"],
    ["different property", "deps.db.query(opts.sqlx, opts.params(opts.repoId, row))"],
    ["other variable", "deps.db.query(sqlText, opts.params(opts.repoId, row))"],
    ["template literal", "deps.db.query(`${opts.sql}`, opts.params(opts.repoId, row))"],
    ["concatenated sql", "deps.db.query(opts.sql + suffix, opts.params(opts.repoId, row))"],
    ["fallback expression", "deps.db.query(opts.sql ?? other, opts.params(opts.repoId, row))"],
    ["conditional expression", "deps.db.query(flag ? opts.sql : other, opts.params(opts.repoId, row))"],
    ["parenthesised sql", "deps.db.query((opts.sql), opts.params(opts.repoId, row))"],
    ["expression after the parameters", "deps.db.query(opts.sql, opts.params(opts.repoId, row) || [])"],
    ["sequence expression", "deps.db.query(opts.sql, (log(), opts.params(opts.repoId, row)))"],
    ["comment inside the call", "deps.db.query(opts.sql /* x */, opts.params(opts.repoId, row))"],
    ["no receiver", "db.query(opts.sql, opts.params(opts.repoId, row))"],
    ["other receiver", "other.db.query(opts.sql, opts.params(opts.repoId, row))"],
    ["other method", "deps.client.query(opts.sql, opts.params(opts.repoId, row))"],
    ["generic call", "deps.db.query<Row>(opts.sql, opts.params(opts.repoId, row))"],
    ["optional call", "deps.db.query?.(opts.sql, opts.params(opts.repoId, row))"],
    ["text after the call", "deps.db.query(opts.sql, opts.params(opts.repoId, row)) + extra"],
    ["identifier split by whitespace", "deps.db.query(op ts.sql, opts.params(opts.repoId, row))"],
    ["identifiers joined", "deps.db.query(opts.sql, opts.params(opts.repoId row))"],
    ["line comment inside the call", "deps.db.query(opts.sql, // x\n opts.params(opts.repoId, row))"],
    ["leading text", "await deps.db.query(opts.sql, opts.params(opts.repoId, row))"],
    ["not a call", ""],
  ];
  for (const [why, call] of rejected) assert.equal(ok(call), false, why);
  assert.equal(ok(null), false, "an unbalanced call");
});

test("scanner: the call handed to the ingestion exception is the complete call, and anything after it is scanned on its own", () => {
  const first = (src: string) => { const m = new RegExp(DATABASE_CALL.source).exec(src)!; return callExpression(src, m.index, m[0]); };
  assert.equal(first("n = (await deps.db.query(opts.sql, opts.params(opts.repoId, row))).rowCount === 1;"), APPROVED_INGEST_CALL);
  assert.equal(first("deps.db.query(opts.sql, ')', opts.params(opts.repoId, row))"), "deps.db.query(opts.sql, ')', opts.params(opts.repoId, row))", "a parenthesis inside a string does not end the call");
  assert.equal(first("deps.db.query(opts.sql, opts.params(opts.repoId, row)"), null, "unbalanced parentheses");
  // The receiver counts only when it is exactly `deps.`: `mydeps.db.query(...)` or `x.deps.db.query(...)` are different calls.
  assert.equal(first("mydeps.db.query(opts.sql, opts.params(opts.repoId, row))"), "db.query(opts.sql, opts.params(opts.repoId, row))");
  assert.equal(first("x.deps.db.query(opts.sql, opts.params(opts.repoId, row))"), "db.query(opts.sql, opts.params(opts.repoId, row))");

  const call = "const r = await deps.db.query(opts.sql, opts.params(opts.repoId, row));";
  assert.deepEqual(unexpectedQueryArguments(INGEST_FILE, call), []);
  assert.equal(unexpectedQueryArguments(join(process.cwd(), "scripts", "other.ts"), call).length, 1, "the same call in another file");
  assert.equal(unexpectedQueryArguments(INGEST_FILE, call.replace("row))", "row), extra)")).length, 1, "an extra argument");
  assert.equal(unexpectedQueryArguments(INGEST_FILE, call.replace("opts.sql", "opts.sql + x")).length, 1, "an extra expression");
  assert.equal(unexpectedQueryArguments(INGEST_FILE, call.replace("deps.db", "other.db")).length, 1, "another receiver");
  // A second query after the approved one is not covered by the exception: it is checked separately and refused.
  assert.equal(unexpectedQueryArguments(INGEST_FILE, `${call} const s = await deps.db.query(userSql, []);`).length, 1);
  assert.equal(unexpectedQueryArguments(INGEST_FILE, `${call} const t = await deps.db.query(SELECT_USERS_SQL);`).length, 0);
});

// The ingestion script is absent from some branches: the pin below runs wherever it exists and is reported as skipped elsewhere.
const ingestSource = (() => { try { return readFileSync(INGEST_FILE, "utf8"); } catch { return null; } })();

test("the ingestion helper receives only UPSERT_ISSUE_SQL and UPSERT_PULL_SQL", { skip: ingestSource === null && "scripts/ingest-data.ts is not present on this branch" }, () => {
  const text = ingestSource as string;
  assert.equal(text.split("opts.sql").length - 1, 1, "opts.sql may be used only by the approved query call");
  // Exactly one query call uses opts.sql, and the complete call is the approved one.
  const calls = [...text.matchAll(/\bdb\.query\(/g)].map((m) => callExpression(text, m.index, m[0])).filter((c): c is string => c !== null && c.includes("opts.sql"));
  assert.equal(calls.length, 1, "exactly one query call uses opts.sql");
  assert.equal(isApprovedDynamicQuery(INGEST_FILE, calls[0]), true, `the call is not the approved one: ${calls[0]}`);
  assert.deepEqual(unexpectedQueryArguments(INGEST_FILE, text), [], "the whole ingestion script passes the database-call check");
  // Property assignments (`sql: NAME,`); the type declaration `sql: string;` ends in a semicolon and is not matched.
  const passed = [...text.matchAll(/^\s+sql:\s*([A-Za-z_][\w.]*),\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(passed, APPROVED_INGEST_SQL);
  for (const name of APPROVED_INGEST_SQL) {
    assert.match(text, new RegExp(`export const ${name} =\\s*"INSERT INTO\\b`), `${name} is a fixed string literal`);
  }
});

// ---------------------------------------------------------------- role escalation: the session is the only authority

const secret = randomBytes(32).toString("base64");
const key = getSessionKey(secret);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("a student token whose role claim is rewritten to mentor, keeping the old signature, is refused", async () => {
  const [h, p, s] = (await signSession({ userId: "7", role: "student" }, key)).split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  for (const role of ["mentor", "lead"]) {
    assert.equal(await verifySession(`${h}.${b64({ ...claims, role })}.${s}`, key), null, role);
  }
  assert.equal(await verifySession(`${h}.${b64({ ...claims, sub: "1" })}.${s}`, key), null, "another user's id");
});

test("tokens with alg none, an empty signature, or another HMAC algorithm are refused", async () => {
  const claims = { sub: "1", role: "mentor", exp: Math.floor(Date.now() / 1000) + 3600 };
  assert.equal(await verifySession(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`, key), null, "alg none");
  assert.equal(await verifySession(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.x`, key), null, "alg none with signature");
  const [h, p] = (await signSession({ userId: "1", role: "mentor" }, key)).split(".");
  assert.equal(await verifySession(`${h}.${p}.`, key), null, "signature removed");
  for (const alg of ["HS384", "HS512"]) {
    const token = await new SignJWT({ role: "mentor" }).setProtectedHeader({ alg }).setSubject("1").setExpirationTime("1h").sign(key);
    assert.equal(await verifySession(token, key), null, `${alg} signed with the real key`);
  }
});

test("a token signed with a guessable or empty-looking secret does not open a session", async () => {
  for (const weak of ["secret", "change_me", "0".repeat(32), "A".repeat(31)]) {
    const forged = await new SignJWT({ role: "mentor" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("1").setExpirationTime("1h")
      .sign(new TextEncoder().encode(weak));
    assert.equal(await verifySession(forged, key), null, weak);
  }
  assert.throws(() => getSessionKey("change_me"), /SESSION_SECRET/); // the .env.example placeholder cannot be used as a secret
});

test("forms cannot carry a role, an author or a repository change: unknown and privileged fields are ignored", () => {
  const edit = parseIssueForm(
    new Map([["title", "t"], ["body", "b"], ["status", "open"], ["priority", "low"], ["role", "mentor"], ["authorId", "1"], ["repositoryId", "99"], ["assigneeId", "1"]]),
    { requireRepository: false },
  );
  assert.equal(edit.ok, true);
  if (edit.ok) {
    assert.equal(edit.repositoryId, null); // an edit cannot move an issue to another repository
    assert.deepEqual(Object.keys(edit.input).sort(), ["body", "priority", "status", "title"]);
  }
});

test("pull request status changes cannot leave merged; approve writes a review and merge is the database procedure", () => {
  for (const a of PR_ACTIONS) {
    assert.ok(!PR_TRANSITIONS[a].from.includes("merged"), `${a} must not start from merged`);
  }
  assert.deepEqual(PR_TRANSITIONS.merge.from, ["approved"]); // a pull request cannot be merged without approval
  assert.deepEqual(PR_TRANSITIONS.approve.from, ["open"]);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /pr\.status = ANY\(\$3::text\[\]\)/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /r\.github_url IS NULL/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /\$2::text IN \('open', 'closed'\)/); // the generic statement can never set merged or approved
  assert.match(APPROVE_PULL_REQUEST_SQL, /INSERT INTO pr_reviews/); // approval is a real review, so the self-review trigger applies
  assert.equal(MERGE_PULL_REQUEST_SQL, "CALL merge_pull_request($1::bigint, $2::bigint)");
});

// ---------------------------------------------------------------- failure cases for configuration and exposure

test("a missing DATABASE_URL fails with a clear message that contains no connection details", async () => {
  const { getPool } = await import("./db");
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => getPool(), (err: Error) => /DATABASE_URL is not set/.test(err.message) && !/postgres/i.test(err.message.replace("DATABASE_URL", "")));
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("secrets stay out of version control: .env is ignored and .env.example holds only placeholders", () => {
  const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes(".env") && ignore.includes(".env.*") && ignore.includes("!.env.example"));
  const example = Object.fromEntries(
    readFileSync(join(process.cwd(), ".env.example"), "utf8").split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.ok((example.SESSION_SECRET ?? "").length < 32, "the example session secret must be too short to be accepted");
  assert.equal(example.GITHUB_TOKEN, "");
  assert.equal(example.SEED_PASSWORD, "");
  assert.doesNotMatch(Object.values(example).join("\n"), /ghp_|github_pat_|AKIA|BEGIN [A-Z ]*PRIVATE KEY/);
});
