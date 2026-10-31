import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECTIONS, INDEXES, NOTIFICATION_TTL_INDEX, assertSafeMongoTarget } from "./mongo-config";

const url = (v: string | undefined) => () => assertSafeMongoTarget({ MONGO_URL: v });

test("the guard accepts only a single local server and the database named codecollab", () => {
  assert.equal(assertSafeMongoTarget({ MONGO_URL: "mongodb://localhost:27017/codecollab" }).description, "localhost:27017/codecollab");
  assert.equal(assertSafeMongoTarget({ MONGO_URL: "mongodb://127.0.0.1/codecollab" }).description, "127.0.0.1:27017/codecollab");
  assert.equal(assertSafeMongoTarget({ MONGO_URL: "mongodb://[::1]:27017/codecollab" }).description, "[::1]:27017/codecollab");
  for (const bad of [
    undefined, "", "mongodb://localhost:27017", "mongodb://localhost:27017/admin", "mongodb://localhost:27017/upskill",
    "mongodb://db.example.com/codecollab", "mongodb://localhost,db.example.com/codecollab", "mongodb+srv://localhost/codecollab",
    "mongodb://localhost/codecollab ", "postgresql://localhost/codecollab", "not a url",
  ]) assert.throws(url(bad), /Refusing/, String(bad));
  assert.throws(() => assertSafeMongoTarget({ MONGO_URL: "mongodb://localhost/codecollab", NODE_ENV: "production" }), /production/);
});

test("the guard's messages never echo the URL or credentials", () => {
  try {
    assertSafeMongoTarget({ MONGO_URL: "mongodb://user:s3cret-pw@db.example.com/codecollab" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.doesNotMatch((err as Error).message, /s3cret|user|example/);
  }
});

test("all four collections have indexes; activity events are unique per outbox row; commit files per (repo, sha)", () => {
  for (const name of Object.values(COLLECTIONS)) assert.ok(INDEXES.some((i) => i.collection === name), name);
  assert.ok(INDEXES.some((i) => i.collection === "activity_events" && i.unique && Object.keys(i.keys).join() === "outboxId"));
  assert.ok(INDEXES.some((i) => i.collection === "commit_files" && i.unique && Object.keys(i.keys).join() === "repo,sha"));
  assert.equal(new Set(INDEXES.map((i) => `${i.collection}.${i.name}`)).size, INDEXES.length, "index names are unique per collection");
});

test("notifications have a TTL index on expiresAt with expireAfterSeconds 0, and it is the only TTL index", () => {
  const ttl = INDEXES.filter((i) => i.expireAfterSeconds !== undefined);
  assert.deepEqual(ttl.map((i) => [i.collection, i.name, i.keys, i.expireAfterSeconds]), [["notifications", NOTIFICATION_TTL_INDEX, { expiresAt: 1 }, 0]]);
});
