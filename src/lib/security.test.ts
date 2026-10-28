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
  GET_PULL_REQUEST_SQL, LIST_PULL_REQUESTS_SQL, TRANSITION_PULL_REQUEST_SQL,
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
      [LIST_ISSUES_SQL, "listIssues", (run) => listIssues({ repositoryId: p, status: p }, 1, run)],
      [GET_ISSUE_SQL, "getIssue", (run) => getIssue(p, run)],
      [LIST_PULL_REQUESTS_SQL, "listPullRequests", (run) => listPullRequests({ repositoryId: p, status: p }, 1, 25, run)],
      [GET_PULL_REQUEST_SQL, "getPullRequest", (run) => getPullRequest(p, run)],
      [MEMBER_CONTRIBUTIONS_SQL, "listMemberContributions", (run) => listMemberContributions(p, run)],
      [MEMBER_CONTRIBUTIONS_SQL, "getMemberEvidence", (run) => getMemberEvidence(p, p, run)],
    ];
    for (const [sql, name, call] of checks) {
      const r = recorder();
      await call(r.run);
      assert.equal(r.calls[0].text, sql, name);
      assert.ok(r.calls[0].params.includes(p), `${name} binds ${JSON.stringify(p)}`);
      // Short numeric look-alikes such as " 1" are legitimate substrings of any SQL text, so only syntax-bearing payloads are checked.
      if (/[;'"]/.test(p)) for (const c of r.calls) assert.ok(!c.text.includes(p), `${name} SQL text must not contain the payload`);
    }
    const t = recorder([{ id: "1", mirrored: false, status: "open" }]);
    await transitionPullRequest(p, "approve", p, t.run);
    assert.equal(t.calls[0].text, TRANSITION_PULL_REQUEST_SQL);
    if (/[;'"]/.test(p)) assert.ok(!t.calls[0].text.includes(p));
    assert.equal(t.calls[0].params[0], p);
    assert.equal(t.calls[0].params[3], p);
    assert.ok(Array.isArray(t.calls[0].params[2])); // allowed statuses are an array parameter, not SQL text
  }
  const c = recorder([{ n: 1 }]);
  await countIssues({ repositoryId: "1' OR '1'='1", status: null }, c.run);
  await countPullRequests({ repositoryId: "1' OR '1'='1", status: null }, c.run);
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
const SQL_WORD = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/;

test("no source file splices a variable into SQL, except the fixed column and clause fragments", () => {
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/`([^`]*)`/g)) {
      if (!SQL_WORD.test(m[1])) continue;
      for (const hole of m[1].matchAll(/\$\{([^}]*)\}/g)) {
        assert.ok(ALLOWED_FRAGMENTS.has(hole[1].trim()), `${file}: \${${hole[1]}} inside a SQL template`);
      }
    }
    // A SQL string literal joined to a non-literal with + would be the other way to build a query from input.
    for (const m of text.matchAll(/"((?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[^"]*)"\s*\+\s*([^\s"`][^\n]*)/g)) {
      assert.fail(`${file}: SQL string concatenated with ${m[2].slice(0, 40)}`);
    }
  }
});

test("every database call passes a fixed SQL string or a *_SQL constant, never a computed one", () => {
  for (const file of files) {
    if (file.endsWith("src/lib/db.ts")) continue; // the helper itself forwards `text`
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:query|client\.query|db\.query|run)(?:<[^>(]*>)?\(\s*/g)) {
      const rest = text.slice(m.index + m[0].length);
      const ok = /^"(?:[^"\\\n]|\\.)*"/.test(rest) || /^[A-Z][A-Z0-9_]*_SQL\b/.test(rest) || /^\)/.test(rest);
      // `run(` is also a name used for parameters of the data-access functions; only calls with a first argument matter.
      if (!ok && /^[A-Za-z_]/.test(rest) && /^(?:text|sql|q)\b/.test(rest)) continue;
      assert.ok(ok, `${file}: unexpected first argument near ${JSON.stringify(rest.slice(0, 50))}`);
    }
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

test("pull request status changes cannot leave merged, and each action only starts from its listed statuses", () => {
  for (const a of PR_ACTIONS) {
    assert.ok(!PR_TRANSITIONS[a].from.includes("merged"), `${a} must not start from merged`);
  }
  assert.deepEqual(PR_TRANSITIONS.merge.from, ["approved"]); // a pull request cannot be merged without approval
  assert.deepEqual(PR_TRANSITIONS.approve.from, ["open"]);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /pr\.status = ANY\(\$3::text\[\]\)/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /r\.github_url IS NULL/);
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
