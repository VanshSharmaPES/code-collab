import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginInput } from "./login-input";

test("normalizes the email but leaves the password untouched", () => {
  const input = parseLoginInput({ email: "  User@Example.COM ", password: "  spaced pw  " });
  assert.deepEqual(input, { email: "user@example.com", password: "  spaced pw  " });
});

test("rejects non-object bodies", () => {
  for (const body of [null, undefined, "x", 5, [], [{ email: "a@b.c", password: "x" }]]) {
    assert.equal(parseLoginInput(body), null);
  }
});

test("rejects missing, non-string and empty fields", () => {
  assert.equal(parseLoginInput({ email: "a@b.c" }), null);
  assert.equal(parseLoginInput({ password: "x" }), null);
  assert.equal(parseLoginInput({ email: 1, password: "x" }), null);
  assert.equal(parseLoginInput({ email: "a@b.c", password: { $ne: "" } }), null);
  assert.equal(parseLoginInput({ email: "   ", password: "x" }), null);
  assert.equal(parseLoginInput({ email: "a@b.c", password: "" }), null);
});

test("enforces length limits", () => {
  assert.notEqual(parseLoginInput({ email: "a@b.c", password: "p".repeat(128) }), null);
  assert.equal(parseLoginInput({ email: "a@b.c", password: "p".repeat(129) }), null);
  assert.equal(parseLoginInput({ email: "a".repeat(251) + "@b.c", password: "x" }), null);
});
