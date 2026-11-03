import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECTIONS, INDEXES, NOTIFICATION_TTL_INDEX, NOTIFICATION_VALIDATOR } from "../src/lib/mongo-config";
import { indexOptions, runMongoSetup, type MongoDbLike } from "./mongo-setup-data";

type Call = [string, ...unknown[]];

// A recording stand-in for the driver's Db. Any method the setup should never use is listed in FORBIDDEN and fails the test.
function fakeDb(existing: string[], failIndex?: { name: string; code: number }) {
  const calls: Call[] = [];
  const db = {
    listCollections: () => ({ toArray: async () => existing.map((name) => ({ name })) }),
    createCollection: async (name: string, ...options: unknown[]) => { calls.push(["createCollection", name, ...options]); },
    collection: (name: string) => ({
      createIndex: async (keys: Record<string, 1 | -1>, options: Record<string, unknown>) => {
        calls.push(["createIndex", name, keys, options]);
        if (failIndex && options.name === failIndex.name) throw Object.assign(new Error("server detail"), { code: failIndex.code });
      },
      drop: () => assert.fail("drop"), dropIndex: () => assert.fail("dropIndex"), deleteMany: () => assert.fail("deleteMany"),
    }),
    dropCollection: () => assert.fail("dropCollection"), dropDatabase: () => assert.fail("dropDatabase"),
  };
  return { db: db as unknown as MongoDbLike, calls };
}

test("a dry run reports what it would do and writes nothing", async () => {
  const { db, calls } = fakeDb(["comments"]);
  const lines: string[] = [];
  await runMongoSetup(db, false, (l) => lines.push(l));
  assert.deepEqual(calls, []);
  assert.ok(lines.includes("  collection comments: exists"));
  assert.ok(lines.includes("  collection notifications: would be created"));
  assert.equal(lines.filter((l) => l.includes("would be ensured")).length, INDEXES.length);
  assert.match(lines.at(-1) ?? "", /Dry run only/);
});

test("apply on an empty server creates the four collections and every index", async () => {
  const { db, calls } = fakeDb([]);
  await runMongoSetup(db, true, () => {});
  assert.deepEqual(calls.filter((c) => c[0] === "createCollection").map((c) => c[1]).sort(), Object.values(COLLECTIONS).sort());
  assert.equal(calls.filter((c) => c[0] === "createIndex").length, INDEXES.length);
});

test("rerunning on existing collections creates none again, and only ever calls create operations", async () => {
  const { db, calls } = fakeDb(Object.values(COLLECTIONS));
  await runMongoSetup(db, true, () => {});
  assert.equal(calls.filter((c) => c[0] === "createCollection").length, 0);
  assert.ok(calls.every((c) => c[0] === "createCollection" || c[0] === "createIndex")); // the fake fails on any drop or delete
});

test("the notifications TTL index is created on expiresAt with expireAfterSeconds 0", async () => {
  const { db, calls } = fakeDb([]);
  await runMongoSetup(db, true, () => {});
  const ttl = calls.find((c) => c[0] === "createIndex" && (c[3] as { name: string }).name === NOTIFICATION_TTL_INDEX);
  assert.deepEqual(ttl, ["createIndex", "notifications", { expiresAt: 1 }, { name: NOTIFICATION_TTL_INDEX, expireAfterSeconds: 0 }]);
  assert.equal(calls.filter((c) => c[0] === "createIndex" && "expireAfterSeconds" in (c[3] as object)).length, 1); // no other TTL index
});

test("only the notifications collection is created with a validator; the other three are created as before", async () => {
  const { db, calls } = fakeDb([]);
  await runMongoSetup(db, true, () => {});
  const created = calls.filter((c) => c[0] === "createCollection");
  assert.deepEqual(created.find((c) => c[1] === COLLECTIONS.notifications), ["createCollection", "notifications", { validator: NOTIFICATION_VALIDATOR }]);
  for (const name of [COLLECTIONS.activityEvents, COLLECTIONS.comments, COLLECTIONS.commitFiles]) {
    assert.deepEqual(created.find((c) => c[1] === name), ["createCollection", name]); // no options at all
  }
  assert.equal(created.length, 4);
});

test("an existing notifications collection is left alone: no validator is added to it", async () => {
  const { db, calls } = fakeDb(Object.values(COLLECTIONS));
  await runMongoSetup(db, true, () => {});
  assert.equal(calls.filter((c) => c[0] === "createCollection").length, 0); // the fake has no collMod, so any attempt would throw
});

test("the notifications validator requires createdAt and expiresAt, when present, to be BSON dates", () => {
  const schema = NOTIFICATION_VALIDATOR.$jsonSchema;
  assert.equal(schema.bsonType, "object");
  assert.deepEqual(schema.properties, { createdAt: { bsonType: "date" }, expiresAt: { bsonType: "date" } });
  assert.ok(!("required" in schema)); // presence is not enforced: no writer exists yet to show every document has both
});

test("unique indexes are created as unique, and plain ones are not", () => {
  const unique = INDEXES.find((i) => i.unique)!;
  assert.deepEqual(indexOptions(unique), { name: unique.name, unique: true });
  const plain = INDEXES.find((i) => !i.unique && i.expireAfterSeconds === undefined)!;
  assert.deepEqual(indexOptions(plain), { name: plain.name });
});

test("a conflicting existing index stops the run with a clear message and changes nothing", async () => {
  for (const code of [85, 86]) {
    const { db, calls } = fakeDb(Object.values(COLLECTIONS), { name: NOTIFICATION_TTL_INDEX, code });
    await assert.rejects(runMongoSetup(db, true, () => {}), (err: Error) =>
      /notifications\.notifications_expires_at_ttl already exists with a different definition/.test(err.message) && !/server detail/.test(err.message));
    assert.ok(calls.every((c) => c[0] === "createIndex"));
  }
});

test("other index errors are passed through unchanged", async () => {
  const { db } = fakeDb(Object.values(COLLECTIONS), { name: INDEXES[0].name, code: 13 });
  await assert.rejects(runMongoSetup(db, true, () => {}), /server detail/);
});
