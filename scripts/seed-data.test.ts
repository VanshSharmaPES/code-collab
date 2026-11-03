import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  INSERT_PROJECT_SQL,
  INSERT_USER_SQL,
  NO_CLIENT,
  PROJECT_EXISTS_SQL,
  SEED_DATABASE_NAME,
  SEED_EMAIL_DOMAIN,
  SEED_PROJECTS,
  SEED_PROJECT_PREFIX,
  SEED_USERS,
  assertSafeTarget,
  describeError,
  describeTarget,
  parseArgs,
  readSeedPassword,
  redactSecrets,
  registerClientErrorHandler,
  runSeed,
  toClientConfig,
  type SeedClient,
} from "./seed-data";

// Random per run: no real credential appears in the repository.
const password = randomBytes(12).toString("hex");
const dbPassword = randomBytes(8).toString("hex");
const fakeHash = async (pw: string) => `hash-of-${pw.length}-${randomBytes(4).toString("hex")}`;
const LOCAL_URL = `postgresql://dbuser:${dbPassword}@localhost:5433/${SEED_DATABASE_NAME}`;

// ---- an in-memory stand-in for the two tables, modelling what the SQL is meant to do ----

type FakeUser = { email: string; githubUsername: string | null; role: string };
type FakeOptions = {
  users?: FakeUser[];
  projects?: string[];
  failOn?: (text: string) => boolean;
  ignoreUserInsert?: (email: string) => boolean;
};

class FakeDb implements SeedClient {
  users: FakeUser[];
  projects: string[];
  calls: string[] = [];
  private snapshot?: { users: FakeUser[]; projects: string[] };

  constructor(private opts: FakeOptions = {}) {
    this.users = [...(opts.users ?? [])];
    this.projects = [...(opts.projects ?? [])];
  }

  async query(text: string, params: readonly unknown[] = []) {
    this.calls.push(text);
    if (this.opts.failOn?.(text)) throw new Error("boom");
    switch (text) {
      case "BEGIN":
        this.snapshot = { users: [...this.users], projects: [...this.projects] };
        return { rowCount: null };
      case "COMMIT":
        this.snapshot = undefined;
        return { rowCount: null };
      case "ROLLBACK":
        if (this.snapshot) ({ users: this.users, projects: this.projects } = this.snapshot);
        return { rowCount: null };
      case INSERT_USER_SQL: {
        const [email, , , role, githubUsername] = params as [string, string, string, string, string];
        if (this.opts.ignoreUserInsert?.(email)) return { rowCount: 0 };
        if (this.users.some((u) => u.email === email)) return { rowCount: 0 }; // ON CONFLICT (email)
        if (this.users.some((u) => u.githubUsername === githubUsername)) {
          // Any other unique violation is NOT covered by the conflict target: it raises.
          throw Object.assign(new Error('duplicate key value violates unique constraint "users_github_username_key"'), { code: "23505" });
        }
        this.users.push({ email, githubUsername, role });
        return { rowCount: 1 };
      }
      case INSERT_PROJECT_SQL: {
        const [name, , , mentorEmail, mentorRole] = params as [string, string, string, string, string];
        const mentor = this.users.find((u) => u.email === mentorEmail && u.role === mentorRole);
        if (!mentor || this.projects.includes(name)) return { rowCount: 0 }; // no row selected / ON CONFLICT (name)
        this.projects.push(name);
        return { rowCount: 1 };
      }
      case PROJECT_EXISTS_SQL:
        return { rowCount: this.projects.includes(params[0] as string) ? 1 : 0 };
      default:
        throw new Error(`unexpected SQL in test: ${text}`);
    }
  }
}

const seedUser = (index: number, overrides: Partial<FakeUser> = {}): FakeUser => ({
  email: SEED_USERS[index].email,
  githubUsername: SEED_USERS[index].githubUsername,
  role: SEED_USERS[index].role,
  ...overrides,
});
const apply = (client: SeedClient) => runSeed(client, { apply: true, password, hash: fakeHash });

// ---- sample data ----

test("sample users satisfy the table constraints and use the skeleton domain only", () => {
  const emails = SEED_USERS.map((u) => u.email);
  const usernames = SEED_USERS.map((u) => u.githubUsername);
  assert.equal(new Set(emails).size, emails.length, "unique emails");
  assert.equal(new Set(usernames).size, usernames.length, "unique github usernames");
  for (const u of SEED_USERS) {
    assert.equal(u.email, u.email.toLowerCase(), "lowercase (users_email_lowercase)");
    assert.ok(u.email.indexOf("@") >= 1, "has @ after the first character (users_email_has_at)");
    assert.ok(u.email.endsWith(`@${SEED_EMAIL_DOMAIN}`));
    assert.ok(!u.email.endsWith("@seed.codecollab.test"), "never the P1-06 domain");
    assert.ok(["student", "lead", "mentor"].includes(u.role));
    assert.ok(u.fullName.length > 0);
  }
});

test("sample projects are prefixed, unique, and each mentor exists with the mentor role", () => {
  const names = SEED_PROJECTS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "unique project names");
  for (const p of SEED_PROJECTS) {
    assert.ok(p.name.startsWith(SEED_PROJECT_PREFIX));
    assert.ok(["active", "archived"].includes(p.status));
    assert.equal(SEED_USERS.find((u) => u.email === p.mentorEmail)?.role, "mentor");
  }
});

// ---- SQL ----

test("SQL is insert-only (plus one read), parameterized, with explicit conflict targets", () => {
  for (const sql of [INSERT_USER_SQL, INSERT_PROJECT_SQL, PROJECT_EXISTS_SQL]) {
    assert.doesNotMatch(sql, /\b(DELETE|TRUNCATE|DROP|ALTER|UPDATE|CREATE)\b/i);
    assert.match(sql, /\$1\b/);
    for (const value of [SEED_EMAIL_DOMAIN, SEED_PROJECT_PREFIX, "Skeleton"]) assert.ok(!sql.includes(value), `${value} must be a parameter`);
    assert.doesNotMatch(sql, /'[^']*'/, "no quoted literals: every value is a bound parameter");
  }
  // Targets come from the UNIQUE columns in db/schema/01_core.sql: users.email, projects.name.
  assert.match(INSERT_USER_SQL, /^INSERT INTO users /);
  assert.match(INSERT_USER_SQL, /ON CONFLICT \(email\) DO NOTHING$/);
  assert.match(INSERT_PROJECT_SQL, /^INSERT INTO projects /);
  assert.match(INSERT_PROJECT_SQL, /ON CONFLICT \(name\) DO NOTHING$/);
  assert.doesNotMatch(INSERT_USER_SQL, /ON CONFLICT DO NOTHING/, "no catch-all conflict handling");
  assert.doesNotMatch(INSERT_PROJECT_SQL, /ON CONFLICT DO NOTHING/, "no catch-all conflict handling");
  assert.match(PROJECT_EXISTS_SQL, /^SELECT /);
  assert.doesNotMatch(INSERT_PROJECT_SQL, /\b\d{2,}\b/, "no hardcoded ids");
});

test("the project insert requires the mentor role and casts its text parameters", () => {
  assert.match(INSERT_PROJECT_SQL, /m\.role = \$5::text/);
  for (const n of [1, 2, 3, 4]) assert.match(INSERT_PROJECT_SQL, new RegExp(`\\$${n}::text`));
});

// ---- target validation ----

test("assertSafeTarget returns the exact connection fields for a local codecollab database", () => {
  assert.deepEqual(assertSafeTarget({ DATABASE_URL: LOCAL_URL }), {
    host: "localhost",
    port: 5433,
    user: "dbuser",
    password: dbPassword,
    database: SEED_DATABASE_NAME,
  });
  assert.equal(assertSafeTarget({ DATABASE_URL: `postgresql://u:p@127.0.0.1/${SEED_DATABASE_NAME}` }).port, 5432, "default port");
  assert.equal(assertSafeTarget({ DATABASE_URL: `postgres://u:p@[::1]:5433/${SEED_DATABASE_NAME}` }).host, "::1");
  assert.equal(assertSafeTarget({ DATABASE_URL: `postgresql://u:p%40x%2F@localhost/${SEED_DATABASE_NAME}` }).password, "p@x/", "percent-decoded");
});

test("the displayed target is exactly what the client is configured with", () => {
  for (const url of [LOCAL_URL, `postgresql://u:p@[::1]:6543/${SEED_DATABASE_NAME}`, `postgresql://u:p@localhost/${SEED_DATABASE_NAME}`]) {
    const target = assertSafeTarget({ DATABASE_URL: url });
    const config = toClientConfig(target);
    const shown = describeTarget(target);
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    assert.equal(shown, `${host}:${config.port}/${config.database}`);
    assert.ok(!("connectionString" in config), "no raw URL is handed to a second parser");
    assert.ok(!shown.includes(target.user) && !shown.includes(target.password), "no credentials in the summary");
  }
  assert.equal(describeTarget(assertSafeTarget({ DATABASE_URL: LOCAL_URL })), "localhost:5433/codecollab");
});

test("leading or trailing whitespace is refused instead of being parsed two different ways", () => {
  for (const url of [` ${LOCAL_URL}`, `${LOCAL_URL} `, `${LOCAL_URL}\n`, `\t${LOCAL_URL}`, LOCAL_URL.replace("localhost", "local host")]) {
    assert.throws(() => assertSafeTarget({ DATABASE_URL: url }), /Refusing to seed: DATABASE_URL contains whitespace/, JSON.stringify(url.slice(0, 12)));
  }
});

test("host, hostaddr and port cannot be overridden through the query string", () => {
  for (const key of ["host", "hostaddr", "port"]) {
    assert.throws(
      () => assertSafeTarget({ DATABASE_URL: `${LOCAL_URL}?${key}=6000` }),
      (err: Error) => err.message.includes(`"${key}"`) && !err.message.includes(dbPassword),
      key,
    );
  }
  // Unrelated parameters are ignored, never copied into the connection.
  const target = assertSafeTarget({ DATABASE_URL: `${LOCAL_URL}?application_name=x` });
  assert.equal(target.port, 5433);
});

test("assertSafeTarget refuses remote hosts, other databases and malformed URLs, without echoing secrets", () => {
  const refusals: Array<[string, Record<string, string | undefined>]> = [
    ["missing url", {}],
    ["unparseable", { DATABASE_URL: "not a url" }],
    ["wrong scheme", { DATABASE_URL: `http://u:${dbPassword}@localhost/${SEED_DATABASE_NAME}` }],
    ["remote host", { DATABASE_URL: `postgresql://u:${dbPassword}@db.example.com:5432/${SEED_DATABASE_NAME}` }],
    ["lookalike host", { DATABASE_URL: `postgresql://u:${dbPassword}@localhost.example.com/${SEED_DATABASE_NAME}` }],
    ["userinfo trick", { DATABASE_URL: `postgresql://localhost:${dbPassword}@evil.example/${SEED_DATABASE_NAME}` }],
    ["no host (socket form)", { DATABASE_URL: `postgresql:///${SEED_DATABASE_NAME}` }],
    ["other database", { DATABASE_URL: `postgresql://u:${dbPassword}@localhost:5433/upskill` }],
    ["no database", { DATABASE_URL: `postgresql://u:${dbPassword}@localhost:5433` }],
    ["case-different database", { DATABASE_URL: `postgresql://u:${dbPassword}@localhost:5433/CodeCollab` }],
    ["no user", { DATABASE_URL: `postgresql://localhost:5433/${SEED_DATABASE_NAME}` }],
    ["bad percent-encoding", { DATABASE_URL: `postgresql://u:%E0%A4%A@localhost/${SEED_DATABASE_NAME}` }],
  ];
  for (const [label, env] of refusals) {
    assert.throws(
      () => assertSafeTarget(env),
      (err: Error) => /^Refusing to seed/.test(err.message) && !err.message.includes(dbPassword),
      label,
    );
  }
});

test("the production check is case-insensitive and tolerant of padding", () => {
  for (const value of ["production", "Production", "PRODUCTION", " production ", "pRoDuCtIoN"]) {
    assert.throws(() => assertSafeTarget({ NODE_ENV: value, DATABASE_URL: LOCAL_URL }), /NODE_ENV is production/, value);
  }
  for (const value of [undefined, "", "development", "test"]) {
    assert.doesNotThrow(() => assertSafeTarget({ NODE_ENV: value, DATABASE_URL: LOCAL_URL }), String(value));
  }
  // It is only a backstop: a non-production run against a remote host is still refused.
  assert.throws(() => assertSafeTarget({ NODE_ENV: "development", DATABASE_URL: `postgresql://u:p@db.example.com/${SEED_DATABASE_NAME}` }), /not local/);
});

test("readSeedPassword requires a value of 8 to 128 characters", () => {
  assert.equal(readSeedPassword({ SEED_PASSWORD: password }), password);
  assert.throws(() => readSeedPassword({}), /not set/);
  assert.throws(() => readSeedPassword({ SEED_PASSWORD: "" }), /not set/);
  assert.throws(() => readSeedPassword({ SEED_PASSWORD: "short" }), /8 to 128/);
  assert.throws(() => readSeedPassword({ SEED_PASSWORD: "x".repeat(129) }), /8 to 128/);
  assert.throws(() => readSeedPassword({ SEED_PASSWORD: "short" }), (err: Error) => !err.message.includes("short"), "error does not echo the value");
});

test("parseArgs defaults to dry run; only --apply enables writes; unknown flags fail", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.throws(() => parseArgs(["--aply"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--apply", "--force"]), /Unknown argument/);
});

// ---- error output ----

test("redactSecrets removes literal and URL-encoded secrets but leaves short values alone", () => {
  const encoded = "p@ss/word-1";
  const text = `connect failed for ${LOCAL_URL} and ${encodeURIComponent(encoded)} and ${password} and ab`;
  const out = redactSecrets(text, [LOCAL_URL, encoded, password, "ab", undefined, ""]);
  assert.ok(!out.includes(LOCAL_URL) && !out.includes(dbPassword) && !out.includes(password) && !out.includes(encodeURIComponent(encoded)));
  assert.ok(out.endsWith("and ab"), "values under 4 characters are not redacted");
  assert.equal(out.split("[redacted]").length - 1, 3);
});

test("describeError keeps the safe diagnostics: message and error code, nothing else", () => {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_github_username_key"'), {
    code: "23505",
    detail: `Key (github_username)=(secret-looking-detail) already exists.`,
    stack: "STACK-MARKER",
    parameters: [dbPassword],
  });
  const line = describeError(pgError, []);
  assert.equal(line, 'duplicate key value violates unique constraint "users_github_username_key" [23505]');
  for (const forbidden of ["secret-looking-detail", "STACK-MARKER", dbPassword]) assert.ok(!line.includes(forbidden), forbidden);
  assert.equal(describeError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" }), []), "connect ECONNREFUSED 127.0.0.1:5433 [ECONNREFUSED]");
});

test("describeError redacts DATABASE_URL and SEED_PASSWORD, ignores odd codes, and truncates", () => {
  const leaky = new Error(`bad config ${LOCAL_URL} with ${password}`);
  const line = describeError(leaky, [LOCAL_URL, password, dbPassword]);
  assert.ok(!line.includes(LOCAL_URL) && !line.includes(password) && !line.includes(dbPassword));
  assert.match(line, /\[redacted\]/);
  assert.equal(describeError(Object.assign(new Error("x"), { code: "has spaces; and <junk>" }), []), "x");
  assert.equal(describeError(Object.assign(new Error("x"), { code: 42 }), []), "x");
  assert.equal(describeError("a string", []), "unknown error");
  assert.equal(describeError(null, []), "unknown error");
  assert.ok(describeError(new Error("y".repeat(5000)), []).length <= 300);
});

test("an empty-message AggregateError (refused connection) falls back to its name plus the code", () => {
  // Node 20 reports a refused connection to `localhost` like this: empty message, code set.
  const refused = Object.assign(new AggregateError([new Error(`inner error mentioning ${dbPassword}`)], ""), { code: "ECONNREFUSED" });
  assert.equal(refused.message, "");
  const line = describeError(refused, [dbPassword]);
  assert.equal(line, "AggregateError [ECONNREFUSED]");
  assert.ok(!line.includes(dbPassword), "inner errors are never printed");
});

test("whitespace-only and empty messages fall back to the error name; real messages are unchanged", () => {
  assert.equal(describeError(new Error(""), []), "Error");
  assert.equal(describeError(new TypeError("   \n\t "), []), "TypeError");
  assert.equal(describeError(Object.assign(new Error(" "), { code: "28P01" }), []), "Error [28P01]");
  assert.equal(describeError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" }), []), "connect ECONNREFUSED 127.0.0.1:5433 [ECONNREFUSED]");
  // Redaction still applies to a real message.
  assert.equal(describeError(new Error(`bad ${password}`), [password]), "bad [redacted]");
});

test("the client error handler logs a redacted line instead of letting the error escape", () => {
  const client = new EventEmitter();
  const lines: string[] = [];
  registerClientErrorHandler(client, [dbPassword], (line) => lines.push(line));
  assert.doesNotThrow(() => client.emit("error", Object.assign(new Error(`terminated, password ${dbPassword}`), { code: "57P01", stack: "STACK-MARKER" })));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Database connection error: terminated, password \[redacted\] \[57P01\]$/);
  assert.ok(!lines[0].includes("STACK-MARKER"));
  // Without the handler, EventEmitter would throw on an unhandled 'error'.
  assert.throws(() => new EventEmitter().emit("error", new Error("unhandled")), /unhandled/);
});

// ---- runner ----

test("dry run plans the rows and never touches the database or hashes anything", async () => {
  let hashed = 0;
  const summary = await runSeed(NO_CLIENT, {
    apply: false,
    password,
    hash: async () => {
      hashed += 1;
      return "x";
    },
  });
  assert.deepEqual(summary, {
    mode: "dry-run",
    users: { planned: SEED_USERS.length, inserted: 0, skipped: 0 },
    projects: { planned: SEED_PROJECTS.length, inserted: 0, skipped: 0 },
  });
  assert.equal(hashed, 0);
  await assert.rejects(NO_CLIENT.query("SELECT 1"), /dry-run/);
});

test("apply on an empty database runs BEGIN, users, projects, COMMIT with bound parameters", async () => {
  const db = new FakeDb();
  const summary = await apply(db);
  assert.deepEqual(db.calls, ["BEGIN", ...SEED_USERS.map(() => INSERT_USER_SQL), ...SEED_PROJECTS.map(() => INSERT_PROJECT_SQL), "COMMIT"]);
  assert.deepEqual(summary.users, { planned: 4, inserted: 4, skipped: 0 });
  assert.deepEqual(summary.projects, { planned: 2, inserted: 2, skipped: 0 });
  assert.equal(db.users.length, 4);
  assert.deepEqual(db.projects, SEED_PROJECTS.map((p) => p.name));
});

test("parameters carry the hash (never the plaintext) and the mentor role", async () => {
  const seen: Array<{ text: string; params: readonly unknown[] }> = [];
  const db = new FakeDb();
  const spy: SeedClient = {
    query: (text, params = []) => {
      seen.push({ text, params });
      return db.query(text, params);
    },
  };
  await apply(spy);
  const userCall = seen.find((c) => c.text === INSERT_USER_SQL)!;
  assert.deepEqual(userCall.params.slice(0, 2), [SEED_USERS[0].email, SEED_USERS[0].fullName]);
  assert.match(String(userCall.params[2]), /^hash-of-/);
  assert.ok(seen.every((c) => !JSON.stringify(c.params).includes(password)), "plaintext password never reaches SQL");
  const projectCall = seen.find((c) => c.text === INSERT_PROJECT_SQL)!;
  assert.deepEqual(projectCall.params, [SEED_PROJECTS[0].name, SEED_PROJECTS[0].description, SEED_PROJECTS[0].status, SEED_PROJECTS[0].mentorEmail, "mentor"]);
});

test("a rerun skips everything that exists and still commits (idempotent)", async () => {
  const db = new FakeDb();
  await apply(db);
  const before = JSON.stringify([db.users, db.projects]);
  const second = await apply(db);
  assert.equal(second.users.inserted + second.projects.inserted, 0);
  assert.equal(second.users.skipped, SEED_USERS.length);
  assert.equal(second.projects.skipped, SEED_PROJECTS.length);
  assert.equal(db.calls.at(-1), "COMMIT");
  assert.equal(JSON.stringify([db.users, db.projects]), before, "nothing changed");
});

test("an email conflict is an ordinary skip; the other rows are still inserted", async () => {
  const db = new FakeDb({ users: [seedUser(1)] });
  const summary = await apply(db);
  assert.deepEqual(summary.users, { planned: 4, inserted: 3, skipped: 1 });
  assert.equal(db.calls.at(-1), "COMMIT");
});

test("a conflicting github_username fails visibly and rolls the whole run back", async () => {
  const stranger: FakeUser = { email: "someone.else@example.test", githubUsername: SEED_USERS[1].githubUsername, role: "student" };
  const db = new FakeDb({ users: [stranger] });
  await assert.rejects(apply(db), (err: Error & { code?: string }) => err.code === "23505" && /users_github_username_key/.test(err.message));
  assert.equal(db.calls.at(-1), "ROLLBACK");
  assert.ok(!db.calls.includes("COMMIT"));
  assert.deepEqual(db.users, [stranger], "the mentor inserted earlier in the run was rolled back");
  assert.deepEqual(db.projects, []);
});

test("an existing project is a skip, not an error", async () => {
  const db = new FakeDb({ users: SEED_USERS.map((_, i) => seedUser(i)), projects: [SEED_PROJECTS[0].name] });
  const summary = await apply(db);
  assert.deepEqual(summary.projects, { planned: 2, inserted: 1, skipped: 1 });
  assert.ok(db.calls.includes(PROJECT_EXISTS_SQL));
  assert.equal(db.calls.at(-1), "COMMIT");
});

test("a mentor email with the wrong role is an error and nothing is committed", async () => {
  const wrongRole = seedUser(0, { role: "student" });
  const db = new FakeDb({ users: [wrongRole] });
  await assert.rejects(apply(db), /Skeleton: Campus Events.*mentor\.one@skeleton\.codecollab\.test.*missing or does not have the mentor role/);
  assert.equal(db.calls.at(-1), "ROLLBACK");
  assert.ok(!db.calls.includes("COMMIT"));
  assert.deepEqual(db.users, [wrongRole], "nothing else was kept");
  assert.deepEqual(db.projects, []);
});

test("a missing mentor row is an error, not an ordinary skip", async () => {
  const db = new FakeDb({ ignoreUserInsert: (email) => email === SEED_USERS[0].email });
  await assert.rejects(apply(db), /missing or does not have the mentor role/);
  assert.equal(db.calls.at(-1), "ROLLBACK");
  assert.deepEqual(db.users, []);
});

test("a generic failure rolls back, never commits, and is rethrown", async () => {
  const db = new FakeDb({ failOn: (text) => text === INSERT_PROJECT_SQL });
  await assert.rejects(apply(db), /boom/);
  assert.equal(db.calls[0], "BEGIN");
  assert.equal(db.calls.at(-1), "ROLLBACK");
  assert.ok(!db.calls.includes("COMMIT"));
  assert.deepEqual(db.users, [], "users inserted before the failure were rolled back");
});

test("if ROLLBACK itself fails, the original error is still the one thrown", async () => {
  const db = new FakeDb({ failOn: (text) => text === INSERT_PROJECT_SQL || text === "ROLLBACK" });
  await assert.rejects(apply(db), /boom/);
  const pgLike = new FakeDb({ users: [{ email: "x@example.test", githubUsername: SEED_USERS[0].githubUsername, role: "student" }], failOn: (t) => t === "ROLLBACK" });
  await assert.rejects(apply(pgLike), (err: Error & { code?: string }) => err.code === "23505", "the unique violation, not the rollback error");
});

test("a hashing failure happens before BEGIN, so no transaction is left open", async () => {
  const db = new FakeDb();
  await assert.rejects(
    runSeed(db, {
      apply: true,
      password,
      hash: async () => {
        throw new Error("hash failed");
      },
    }),
    /hash failed/,
  );
  assert.equal(db.calls.length, 0);
});
