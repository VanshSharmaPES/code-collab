import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST_USERS_SQL, MAX_USERS, listUsers, toUserListItem } from "./users";

const row = {
  id: "7",
  full_name: "Test Person",
  email: "test.person@example.test",
  role: "student",
  github_username: null,
  created_at: new Date("2026-01-02T03:04:05Z"),
};

test("the query selects an explicit column list and never credentials", () => {
  assert.doesNotMatch(LIST_USERS_SQL, /password/i);
  assert.doesNotMatch(LIST_USERS_SQL, /\*/);
  const columns = LIST_USERS_SQL.match(/^SELECT (.+) FROM users/i)?.[1].split(",").map((c) => c.trim());
  assert.deepEqual(columns, ["id", "full_name", "email", "role", "github_username", "created_at"]);
});

test("the row limit is a bound parameter, not interpolated", async () => {
  assert.match(LIST_USERS_SQL, /LIMIT \$1$/);
  let seen: { text: string; params: readonly unknown[] } | undefined;
  await listUsers(async (text, params) => {
    seen = { text, params };
    return [];
  });
  assert.deepEqual(seen, { text: LIST_USERS_SQL, params: [MAX_USERS] });
});

test("mapping copies only the known fields, even if a row carries extra ones", () => {
  const withExtras = { ...row, password_hash: "should-never-appear", session: "x" };
  const item = toUserListItem(withExtras);
  assert.deepEqual(item, {
    id: "7",
    fullName: "Test Person",
    email: "test.person@example.test",
    role: "student",
    githubUsername: null,
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  assert.ok(!JSON.stringify(item).includes("should-never-appear"));
});

test("listUsers maps every returned row and accepts string timestamps", async () => {
  const items = await listUsers(async () => [row, { ...row, id: "8", created_at: "2026-03-04T00:00:00Z" }]);
  assert.deepEqual(items.map((i) => i.id), ["7", "8"]);
  assert.equal(items[1].createdAt, "2026-03-04T00:00:00.000Z");
});

test("a database failure propagates so the page can show its error state", async () => {
  await assert.rejects(
    listUsers(async () => {
      throw new Error("db down");
    }),
    /db down/,
  );
});
