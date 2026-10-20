import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mock, test } from "node:test";
import { SignJWT } from "jose";
import {
  SESSION_COOKIE_PATH,
  SESSION_MAX_AGE_SECONDS,
  getSessionKey,
  isSessionRole,
  readSession,
  sessionCookieOptions,
  signSession,
  toSessionPayload,
  verifySession,
} from "./session-token";

const secret = randomBytes(32).toString("base64");
const key = getSessionKey(secret);

test("rejects a missing or short secret without echoing it", () => {
  assert.throws(() => getSessionKey(undefined), /SESSION_SECRET/);
  assert.throws(() => getSessionKey("short-secret"), (err: Error) => !err.message.includes("short-secret"));
});

test("round-trips a minimal payload", async () => {
  const token = await signSession({ userId: "42", role: "lead" }, key);
  assert.deepEqual(await verifySession(token, key), { userId: "42", role: "lead" });
});

test("rejects tokens signed with another key, or tampered with", async () => {
  const token = await signSession({ userId: "42", role: "student" }, key);
  const otherKey = getSessionKey(randomBytes(32).toString("base64"));
  assert.equal(await verifySession(token, otherKey), null);
  const [h, p, s] = token.split(".");
  assert.equal(await verifySession(`${h}.${p}x.${s}`, key), null);
  assert.equal(await verifySession("garbage", key), null);
});

test("rejects expired tokens and unknown roles", async () => {
  const expired = await new SignJWT({ role: "student" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(key);
  assert.equal(await verifySession(expired, key), null);

  const badRole = await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1")
    .setExpirationTime("1h")
    .sign(key);
  assert.equal(await verifySession(badRole, key), null);
});

test("rejects tokens whose subject is missing, empty or not a string", async () => {
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ role: "student", ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(key);

  assert.equal(await verifySession(await sign({}), key), null, "no sub");
  assert.equal(await verifySession(await sign({ sub: "" }), key), null, "empty sub");
  assert.equal(await verifySession(await sign({ sub: 42 }), key), null, "numeric sub");
  assert.equal(await verifySession(await sign({ sub: { id: 1 } }), key), null, "object sub");
  assert.deepEqual(await verifySession(await sign({ sub: "7" }), key), { userId: "7", role: "student" });
});

test("only the three known roles are accepted", async () => {
  for (const role of ["student", "lead", "mentor"] as const) {
    const token = await signSession({ userId: "1", role }, key);
    assert.deepEqual(await verifySession(token, key), { userId: "1", role });
  }
  const sign = (role: unknown) =>
    new SignJWT({ role }).setProtectedHeader({ alg: "HS256" }).setSubject("1").setExpirationTime("1h").sign(key);
  for (const role of ["admin", "", "Student", undefined, null, 1, ["student"]]) {
    assert.equal(await verifySession(await sign(role), key), null, String(role));
  }
});

test("cookie options use path / (shared with deletion) and are HttpOnly, SameSite=Lax", () => {
  assert.equal(SESSION_COOKIE_PATH, "/");
  const options = sessionCookieOptions(true);
  assert.deepEqual(options, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: SESSION_COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  assert.equal(sessionCookieOptions(false).secure, false);
});

test("isSessionRole accepts exactly student, lead and mentor", () => {
  for (const role of ["student", "lead", "mentor"]) assert.equal(isSessionRole(role), true, role);
  for (const role of ["admin", "Student", "LEAD", " mentor", "mentor ", "", null, undefined, 1, ["lead"], {}]) {
    assert.equal(isSessionRole(role), false, String(role));
  }
});

test("toSessionPayload rejects unexpected database role or id values", () => {
  assert.deepEqual(toSessionPayload("5", "lead"), { userId: "5", role: "lead" });
  assert.equal(toSessionPayload("5", "admin"), null);
  assert.equal(toSessionPayload("5", null), null);
  assert.equal(toSessionPayload("5", undefined), null);
  assert.equal(toSessionPayload("", "student"), null);
  assert.equal(toSessionPayload(5, "student"), null);
  assert.equal(toSessionPayload(null, "student"), null);
});

test("readSession: no cookie returns null without needing the secret and without logging", async () => {
  const log = mock.method(console, "error", () => {});
  try {
    assert.equal(await readSession(undefined, undefined), null);
    assert.equal(await readSession("", undefined), null);
    assert.equal(log.mock.callCount(), 0);
  } finally {
    log.mock.restore();
  }
});

test("readSession fails closed on a present cookie with a missing or short secret", async () => {
  const token = await signSession({ userId: "9", role: "lead" }, key);
  const log = mock.method(console, "error", () => {});
  try {
    assert.equal(await readSession(token, undefined), null, "missing secret");
    assert.equal(await readSession(token, ""), null, "empty secret");
    assert.equal(await readSession(token, "too-short"), null, "short secret");
    assert.equal(log.mock.callCount(), 3, "each failure is logged");
    const logged = log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.ok(!logged.includes(token) && !logged.includes("too-short"), "log contains no token or secret");
  } finally {
    log.mock.restore();
  }
});

test("readSession returns the session for a valid token and secret, null for a bad token", async () => {
  const token = await signSession({ userId: "9", role: "mentor" }, key);
  assert.deepEqual(await readSession(token, secret), { userId: "9", role: "mentor" });
  assert.equal(await readSession(`${token}x`, secret), null);
  assert.equal(await readSession(token, randomBytes(32).toString("base64")), null, "wrong secret");
});
