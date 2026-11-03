import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { hashPassword, verifyDummyPassword, verifyPassword } from "./password";

// Passwords are random per run, so no real credentials appear in the repository.
const password = randomBytes(12).toString("hex");

test("hashes with Argon2id and verifies the right password only", async () => {
  const stored = await hashPassword(password);
  assert.ok(stored.startsWith("$argon2id$"));
  assert.notEqual(stored, await hashPassword(password), "hashes are salted");
  assert.equal(await verifyPassword(stored, password), true);
  assert.equal(await verifyPassword(stored, password + "x"), false);
  assert.equal(await verifyPassword(stored, ` ${password}`), false, "no trimming");
});

test("a malformed stored hash is a mismatch, not an exception", async () => {
  assert.equal(await verifyPassword("not-a-hash", password), false);
  assert.equal(await verifyPassword("", password), false);
});

test("dummy verification completes without throwing", async () => {
  await verifyDummyPassword(password);
});
