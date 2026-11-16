import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FIND_USER_SQL, LOGIN_ERRORS, authenticate, type LoginDeps } from "./login";
import { config } from "../proxy";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// A fake database and password check: ada@x.test / "right" is a lead with id 7.
function fake(over: Partial<LoginDeps> = {}) {
  const calls: string[] = [];
  const deps: LoginDeps = {
    async findUser(email) { calls.push(`find:${email}`); return email === "ada@x.test" ? { id: "7", password_hash: "hash", role: "lead" } : undefined; },
    async verifyPassword(_hash, password) { calls.push("verify"); return password === "right"; },
    async verifyDummyPassword() { calls.push("dummy"); },
    ...over,
  };
  return { deps, calls };
}

test("a correct email and password give a session with the user's id and the role from the database", async () => {
  const { deps } = fake();
  assert.deepEqual(await authenticate({ email: "ada@x.test", password: "right" }, deps), { ok: true, session: { userId: "7", role: "lead" } });
});

test("the email is trimmed and lowercased; the password is used exactly as typed", async () => {
  const { deps, calls } = fake();
  assert.equal((await authenticate({ email: "  ADA@x.test ", password: "right" }, deps)).ok, true);
  assert.deepEqual(calls[0], "find:ada@x.test");
  assert.equal((await authenticate({ email: "ada@x.test", password: " right" }, deps)).ok, false);
});

test("a wrong password and an unknown email give the same answer, and an unknown email still checks a dummy hash", async () => {
  const a = fake();
  const b = fake();
  assert.deepEqual(await authenticate({ email: "ada@x.test", password: "wrong" }, a.deps), { ok: false, error: "invalid" });
  assert.deepEqual(await authenticate({ email: "nobody@x.test", password: "wrong" }, b.deps), { ok: false, error: "invalid" });
  assert.deepEqual(a.calls, ["find:ada@x.test", "verify"]);
  assert.deepEqual(b.calls, ["find:nobody@x.test", "dummy"]);
});

test("missing, non-string and over-long input is refused before the database is touched", async () => {
  for (const [email, password] of [[null, "x"], ["a@x.test", null], ["", "x"], ["a@x.test", ""], [{ $ne: 1 }, "x"], ["a@x.test", ["x"]], ["a".repeat(255), "x"], ["a@x.test", "p".repeat(129)]] as const) {
    const { deps, calls } = fake();
    assert.deepEqual(await authenticate({ email, password }, deps), { ok: false, error: "invalid" });
    assert.deepEqual(calls, []);
  }
});

test("a users row with an unknown role or an empty id is refused, not turned into a session", async () => {
  for (const row of [{ id: "7", password_hash: "h", role: "admin" }, { id: "", password_hash: "h", role: "lead" }]) {
    const { deps } = fake({ findUser: async () => row, verifyPassword: async () => true });
    assert.deepEqual(await authenticate({ email: "ada@x.test", password: "right" }, deps), { ok: false, error: "failed" });
  }
});

test("a database failure gives the 'failed' answer, not a thrown error or a wrong-password message", async () => {
  const { deps } = fake({ findUser: async () => { throw new Error("db down"); } });
  assert.deepEqual(await authenticate({ email: "ada@x.test", password: "right" }, deps), { ok: false, error: "failed" });
  assert.notEqual(LOGIN_ERRORS.failed, LOGIN_ERRORS.invalid);
});

test("the lookup is a bound parameter and selects only what sign-in needs", () => {
  assert.match(FIND_USER_SQL, /WHERE email = \$1$/);
  assert.doesNotMatch(FIND_USER_SQL, /\*|full_name|github/);
});

test("every sign-in error message is fixed text", () => {
  for (const msg of Object.values(LOGIN_ERRORS)) assert.match(msg, /^[A-Z].*\.$/);
});

test("visitors without a session are sent to the login page, and the login page itself is never behind that redirect", () => {
  assert.match(read("./session.ts"), /export const UNAUTHENTICATED_REDIRECT = "\/login";/);
  assert.match(read("../proxy.ts"), /new URL\("\/login", request\.url\)/);
  assert.ok(config.matcher.includes("/"));
  assert.ok(!config.matcher.some((m) => m === "/login" || m.startsWith("/login/")), "a redirect loop");
});

test("the sign-in action creates the session itself and only redirects to fixed paths", () => {
  const src = read("../app/login/actions.ts");
  assert.match(src, /await createSession\(result\.session\)/);
  assert.doesNotMatch(src, /redirect\(\s*(formData|searchParams|request)/);
  assert.match(src, /redirect\(error \? `\/login\?error=\$\{error\}` : "\/"\)/);
  assert.match(src, /await deleteSession\(\);\s*redirect\("\/login"\)/);
});

test("the login page and header render text as escaped React children and use a server action form", () => {
  for (const f of ["../app/login/page.tsx", "../app/site-header.tsx"]) assert.doesNotMatch(read(f), /dangerouslySetInnerHTML/);
  assert.match(read("../app/login/page.tsx"), /<form action=\{loginAction\}/);
  assert.match(read("../app/login/page.tsx"), /<Suspense fallback=\{<LoginForm message=\{null\} \/>\}>/); // cookies and searchParams need a boundary (cacheComponents)
  assert.match(read("../app/login/page.tsx"), /type="password"/);
  assert.match(read("../app/site-header.tsx"), /<form action=\{logoutAction\}/);
  assert.match(read("../app/layout.tsx"), /<Suspense fallback=\{null\}><SiteHeader \/><\/Suspense>/); // cookies need a Suspense boundary (cacheComponents)
});

test("the header links every signed-in page, and only shows the dashboard to a mentor or lead", () => {
  const src = read("../app/site-header.tsx");
  for (const href of ["/dashboard", "/issues", "/pull-requests", "/contributions", "/search", "/users"]) assert.match(src, new RegExp(`href: "${href}"`));
  assert.match(src, /managersOnly: true/);
  assert.match(src, /!l\.managersOnly \|\| session\.role !== "student"/);
  for (const href of ["/dashboard", "/search"]) assert.ok(config.matcher.includes(href), `${href} is protected by the proxy`);
});
