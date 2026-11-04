import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_SQL, MARK_DONE_SQL, MARK_FAILED_SQL, MAX_CONSECUTIVE_FAILURES, createMongoSink, processBatch, toActivityEvent, type OutboxDb, type OutboxRow } from "./outbox-data";

const row = (id: string, over: Partial<OutboxRow> = {}): OutboxRow => ({
  id, event_type: "issue.created", aggregate_type: "issue", aggregate_id: "7",
  payload: { issueId: "7", repositoryId: "4", actorId: "9", title: "t" }, attempts: 0, created_at: new Date("2026-10-21T10:00:00Z"), ...over,
});

// A fake PostgreSQL: records every statement and serves the claimed rows.
function fakeDb(rows: OutboxRow[], failOn?: string) {
  const log: { text: string; params?: readonly unknown[] }[] = [];
  const db: OutboxDb = {
    async query(text, params) {
      log.push({ text, params });
      if (failOn && text === failOn) throw new Error("db down");
      return { rows: text === CLAIM_SQL ? (rows as unknown as Record<string, unknown>[]) : [] };
    },
  };
  return { db, log };
}
// A fake MongoDB collection that behaves like the real one for upsert + $setOnInsert on a unique key.
function fakeMongo(failFirst = 0, duplicateKeyOnce = false) {
  const store = new Map<string, unknown>();
  let writes = 0, failures = failFirst, dup = duplicateKeyOnce;
  const db = {
    collection: (name: string) => {
      assert.equal(name, "activity_events");
      return {
        async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
          writes++;
          if (failures > 0) { failures--; throw new Error("mongo down"); }
          if (dup) { dup = false; throw Object.assign(new Error("E11000"), { code: 11000 }); }
          const key = String(filter.outboxId);
          if (!store.has(key)) store.set(key, update.$setOnInsert);
          return {};
        },
      };
    },
  };
  return { db, store, get writes() { return writes; } };
}
const describe = (e: unknown) => (e instanceof Error ? e.message : "unknown");

test("delivered rows are marked done inside one transaction, in id order", async () => {
  const { db, log } = fakeDb([row("1"), row("2")]);
  const mongo = fakeMongo();
  const r = await processBatch(db, createMongoSink(mongo.db), describe);
  assert.deepEqual(r, { claimed: 2, delivered: 2, failed: 0, parked: 0, deferred: 0 });
  assert.deepEqual(log.map((l) => l.text), ["BEGIN", CLAIM_SQL, MARK_DONE_SQL, MARK_DONE_SQL, "COMMIT"]);
  assert.deepEqual(mongo.store.size, 2);
});

test("duplicate delivery is harmless: the same outbox row delivered twice leaves one unchanged event", async () => {
  const mongo = fakeMongo();
  const sink = createMongoSink(mongo.db);
  await sink.deliver(row("5"));
  const first = JSON.stringify([...mongo.store]);
  await sink.deliver(row("5", { payload: { changed: true } })); // a replay can never overwrite the stored event
  assert.equal(mongo.store.size, 1);
  assert.equal(JSON.stringify([...mongo.store]), first);
});

test("a duplicate-key error from a concurrent worker counts as delivered; other errors do not", async () => {
  await createMongoSink(fakeMongo(0, true).db).deliver(row("6"));
  await assert.rejects(createMongoSink(fakeMongo(1).db).deliver(row("6")), /mongo down/);
});

test("a failed delivery schedules a retry and does not stop the rest of the batch", async () => {
  const { db, log } = fakeDb([row("1"), row("2", { attempts: 3 })]);
  const mongo = fakeMongo(1); // the first write fails
  const r = await processBatch(db, createMongoSink(mongo.db), describe);
  assert.deepEqual(r, { claimed: 2, delivered: 1, failed: 1, parked: 0, deferred: 0 });
  const failed = log.find((l) => l.text === MARK_FAILED_SQL);
  assert.deepEqual(failed?.params, ["1", "mongo down", 10]);
  assert.equal(log.at(-1)?.text, "COMMIT");
});

test("a row that reaches the attempt limit is reported as parked, and the SQL parks it at 'infinity'", async () => {
  const { db } = fakeDb([row("1", { attempts: 9 })]);
  const r = await processBatch(db, createMongoSink(fakeMongo(1).db), describe);
  assert.equal(r.parked, 1);
  assert.match(MARK_FAILED_SQL, /attempts \+ 1 >= \$3::int THEN 'infinity'::timestamptz/);
  assert.match(MARK_FAILED_SQL, /LEAST\(3600, 5 \* power\(2, attempts\)\)/);
});

test("error text stored with a failed row is capped", async () => {
  const { db, log } = fakeDb([row("1")]);
  const sink = { deliver: async () => { throw new Error("x".repeat(5000)); } };
  await processBatch(db, sink, describe);
  assert.equal((log.find((l) => l.text === MARK_FAILED_SQL)?.params?.[1] as string).length, 300);
});

test("if the PostgreSQL bookkeeping fails the transaction is rolled back and the error is raised", async () => {
  const { db, log } = fakeDb([row("1")], MARK_DONE_SQL);
  await assert.rejects(processBatch(db, createMongoSink(fakeMongo().db), describe), /db down/);
  assert.equal(log.at(-1)?.text, "ROLLBACK");
  assert.ok(!log.some((l) => l.text === "COMMIT"));
});

test("the claim query locks rows with SKIP LOCKED, only unprocessed due rows, oldest first", () => {
  assert.match(CLAIM_SQL, /WHERE processed_at IS NULL AND next_attempt_at <= now\(\) ORDER BY id LIMIT \$1 FOR UPDATE SKIP LOCKED/);
});

test("the event document comes only from the outbox row", () => {
  const ev = toActivityEvent(row("8"));
  assert.deepEqual(Object.keys(ev).sort(), ["actorId", "aggregateId", "aggregateType", "data", "occurredAt", "outboxId", "repositoryId", "type"]);
  assert.equal(ev.outboxId, "8");
  assert.equal(ev.repositoryId, "4");
  assert.ok(ev.occurredAt instanceof Date);
  assert.equal(toActivityEvent(row("9", { payload: {} })).actorId, null);
});

test("when MongoDB is down the batch stops after a few failures; untouched rows stay pending and the transaction still commits", async () => {
  const rows = ["1", "2", "3", "4", "5"].map((id) => row(id));
  const { db, log } = fakeDb(rows);
  const mongo = fakeMongo(99); // every write fails
  const r = await processBatch(db, createMongoSink(mongo.db), describe);
  assert.deepEqual(r, { claimed: 5, delivered: 0, failed: MAX_CONSECUTIVE_FAILURES, parked: 0, deferred: 5 - MAX_CONSECUTIVE_FAILURES });
  assert.equal(mongo.writes, MAX_CONSECUTIVE_FAILURES); // rows 4 and 5 were never sent
  assert.equal(log.filter((l) => l.text === MARK_FAILED_SQL).length, MAX_CONSECUTIVE_FAILURES);
  assert.equal(log.at(-1)?.text, "COMMIT");
});

test("one bad row does not stop the batch: a success resets the run of failures", async () => {
  const { db } = fakeDb(["1", "2", "3", "4", "5", "6"].map((id) => row(id)));
  let n = 0;
  const sink = { deliver: async () => { if (++n % 2 === 1) throw new Error("bad"); } }; // fail, ok, fail, ok, ...
  const r = await processBatch(db, sink, describe);
  assert.deepEqual(r, { claimed: 6, delivered: 3, failed: 3, parked: 0, deferred: 0 });
});

test("an event is a message that a failed or missing delivery can never mark as processed", async () => {
  const { db, log } = fakeDb([row("1")]);
  await processBatch(db, { deliver: async () => { throw undefined; } }, describe); // even a thrown undefined counts as a failure
  assert.ok(!log.some((l) => l.text === MARK_DONE_SQL));
  assert.ok(log.some((l) => l.text === MARK_FAILED_SQL));
});
