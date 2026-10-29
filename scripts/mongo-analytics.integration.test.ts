// Integration test against a REAL MongoDB. It is skipped unless TEST_MONGO_URL is set, so `npm test` needs no server.
//   TEST_MONGO_URL=mongodb://127.0.0.1:27017 npm test
// Safety: only a single local server is accepted, and the test works in its own database with a random name
// (cc_analytics_test_*), which it drops at the end. It never opens the "codecollab" database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { COLLECTIONS, INDEXES } from "../src/lib/mongo-config";
import { monthlyActivity, monthlyEvents, topFiles } from "../src/lib/mongo-analytics";
import { createMongoSink, type OutboxRow } from "./outbox-data";

const url = process.env.TEST_MONGO_URL;
if (url) {
  const u = new URL(url);
  assert.ok(u.protocol === "mongodb:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname), "TEST_MONGO_URL must be one local mongodb:// server");
  assert.ok(u.pathname === "/" || u.pathname === "", "TEST_MONGO_URL must not name a database");
}

const D = (s: string) => new Date(s);
const f = (filename: unknown, additions: unknown, deletions: unknown) => ({ filename, status: "modified", additions, deletions, changes: 0, previous_filename: null });
const commit = (repo: unknown, sha: unknown, committedAt: unknown, authorLogin: string | null, files: unknown) => ({ repo, sha, committedAt, authorLogin, files });

const COMMITS = [
  commit("o/a", "s1", D("2026-01-31T23:30:00Z"), "u1", [f("a.js", 2, 1), f("b.js", 3, 0)]),
  commit("o/a", "s2", D("2026-02-01T00:00:00Z"), "u1", [f("a.js", 1, 1)]),
  commit("o/a", "s2", D("2026-02-01T00:00:00Z"), "u1", [f("a.js", 1, 1)]), // exact duplicate of s2
  commit("o/a", "s3", D("2026-02-15T12:00:00Z"), null, [f("a.js", 4, 4), f("c.js", 0, 5)]),
  commit("o/a", "s4", D("2026-02-20T12:00:00Z"), "u2", []),
  commit("o/a", "s6", D("2026-02-10T12:00:00Z"), "u2", undefined), // no files field
  commit("o/a", "s7", D("2026-02-11T12:00:00Z"), "u1", "oops"), // files is not an array
  commit("o/a", "s8", D("2026-02-12T12:00:00Z"), null, [f(null, "x", undefined), f("d.js", "7", 2)]), // bad filename; additions is a string
  commit("o/b", "s9", D("2026-03-05T12:00:00Z"), "u3", [f("a.js", 1, 1)]),
  // malformed: none of these may count, and none may make the aggregation fail
  commit("o/a", "m1", "2026-02-02", "u1", [f("z.js", 9, 9)]), // timestamp is a string
  commit("o/a", "m2", undefined, "u1", [f("z.js", 9, 9)]), // no timestamp
  commit("o/a", "m3", null, "u1", [f("z.js", 9, 9)]), // null timestamp
  commit("o/a", undefined, D("2026-02-03T00:00:00Z"), "u1", [f("z.js", 9, 9)]), // no sha
  commit(undefined, "m5", D("2026-02-03T00:00:00Z"), "u1", [f("z.js", 9, 9)]), // no repo
];

const EV = (outboxId: unknown, type: unknown, occurredAt: unknown, repositoryId: string | null) => ({ outboxId, type, occurredAt, repositoryId });
const EVENTS = [
  EV("1", "pull_request.status_changed", D("2026-01-31T23:59:59Z"), "4"),
  EV("1", "pull_request.status_changed", D("2026-01-31T23:59:59Z"), "4"), // duplicate delivery of outbox row 1
  EV("2", "issue.status_changed", D("2026-02-03T10:00:00Z"), "4"),
  EV("3", "pull_request.status_changed", D("2026-02-04T10:00:00Z"), "5"),
  EV("4", "issue.status_changed", "2026-02-05", "4"), // timestamp is a string
  EV(undefined, "issue.status_changed", D("2026-02-05T10:00:00Z"), "4"), // no outbox id
  EV("6", undefined, D("2026-02-05T10:00:00Z"), "4"), // no type
];

describe("aggregation pipelines against a real MongoDB", { skip: url ? false : "set TEST_MONGO_URL to a local MongoDB to run" }, () => {
  let client: MongoClient;
  let db: Db;
  const dbName = `cc_analytics_test_${randomBytes(6).toString("hex")}`;

  before(async () => {
    client = new MongoClient(url as string, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(dbName);
    // No unique indexes here on purpose: the pipelines must hold up even when duplicates got in.
    await db.collection(COLLECTIONS.commitFiles).insertMany(COMMITS as never[]);
    await db.collection(COLLECTIONS.activityEvents).insertMany(EVENTS as never[]);
  });
  after(async () => {
    if (!client) return;
    assert.match(dbName, /^cc_analytics_test_[0-9a-f]{12}$/);
    await db.dropDatabase(); // only the database this test created
    await client.close();
  });

  const commitFiles = () => db.collection(COLLECTIONS.commitFiles);

  it("monthly activity: UTC months, duplicates and malformed documents ignored, files and lines summed", async () => {
    assert.deepEqual(await monthlyActivity(commitFiles()), [
      { month: "2026-01", repo: "o/a", commits: 1, filesChanged: 2, additions: 5, deletions: 1, activeAuthors: 1 },
      { month: "2026-02", repo: "o/a", commits: 6, filesChanged: 5, additions: 5, deletions: 12, activeAuthors: 2 },
      { month: "2026-03", repo: "o/b", commits: 1, filesChanged: 1, additions: 1, deletions: 1, activeAuthors: 1 },
    ]);
  });

  it("date boundaries: 23:30 UTC on 31 January is January; since is inclusive and until is exclusive", async () => {
    const jan = await monthlyActivity(commitFiles(), { until: D("2026-02-01T00:00:00Z") });
    assert.deepEqual(jan.map((r) => [r.month, r.commits]), [["2026-01", 1]]);
    const feb = await monthlyActivity(commitFiles(), { since: D("2026-02-01T00:00:00Z"), until: D("2026-03-01T00:00:00Z") });
    assert.deepEqual(feb.map((r) => [r.month, r.commits]), [["2026-02", 6]]); // s2 sits exactly on `since`
    assert.deepEqual((await monthlyActivity(commitFiles(), { since: D("2026-02-01T00:00:01Z"), until: D("2026-02-11T12:00:00Z") })).map((r) => r.commits), [1]); // only s6; s7 sits exactly on `until`
  });

  it("repository filter and empty results", async () => {
    assert.deepEqual((await monthlyActivity(commitFiles(), { repo: "o/b" })).map((r) => r.month), ["2026-03"]);
    assert.deepEqual(await monthlyActivity(commitFiles(), { repo: "nope/nope" }), []);
    assert.deepEqual(await monthlyActivity(commitFiles(), { since: D("2030-01-01T00:00:00Z") }), []);
    assert.deepEqual(await topFiles(commitFiles(), { repo: "nope/nope" }), []);
  });

  it("top files: commits per file, duplicates and malformed entries ignored, stable tie order, limit", async () => {
    const rows = await topFiles(commitFiles(), {}, 10);
    assert.deepEqual(rows.map((r) => [r.repo, r.filename, r.modifications, r.additions, r.deletions]), [
      ["o/a", "a.js", 3, 7, 6],
      ["o/a", "b.js", 1, 3, 0],
      ["o/a", "c.js", 1, 0, 5],
      ["o/a", "d.js", 1, 0, 2], // additions "7" is a string and adds nothing
      ["o/b", "a.js", 1, 1, 1],
    ]);
    assert.deepEqual(rows[0].lastModified, D("2026-02-15T12:00:00Z"));
    assert.equal((await topFiles(commitFiles(), {}, 2)).length, 2);
    assert.deepEqual((await topFiles(commitFiles(), { repo: "o/b" })).map((r) => r.filename), ["a.js"]);
    assert.deepEqual((await topFiles(commitFiles(), { until: D("2026-02-01T00:00:00Z") })).map((r) => r.filename), ["a.js", "b.js"]);
  });

  it("events: duplicates and malformed events ignored, UTC month, filters", async () => {
    const col = db.collection(COLLECTIONS.activityEvents);
    assert.deepEqual(await monthlyEvents(col), [
      { month: "2026-01", type: "pull_request.status_changed", events: 1 },
      { month: "2026-02", type: "issue.status_changed", events: 1 },
      { month: "2026-02", type: "pull_request.status_changed", events: 1 },
    ]);
    assert.deepEqual((await monthlyEvents(col, { repositoryId: "4" })).map((r) => [r.month, r.type, r.events]), [
      ["2026-01", "pull_request.status_changed", 1], ["2026-02", "issue.status_changed", 1],
    ]);
    assert.deepEqual((await monthlyEvents(col, { type: "issue.status_changed" })).length, 1);
    assert.deepEqual(await monthlyEvents(col, { repositoryId: "999" }), []);
  });

  it("the real outbox sink delivering the same row twice does not inflate the analytics (P2-10 contract)", async () => {
    const eventsDb = client.db(`${dbName}_sink`);
    try {
      for (const spec of INDEXES.filter((i) => i.collection === COLLECTIONS.activityEvents)) {
        await eventsDb.collection(spec.collection).createIndex(spec.keys, { name: spec.name, ...(spec.unique ? { unique: true } : {}) });
      }
      const sink = createMongoSink(eventsDb);
      const row: OutboxRow = { id: "77", event_type: "pull_request.status_changed", aggregate_type: "pull_request", aggregate_id: "9", attempts: 0,
        payload: { repositoryId: "4", actorId: "2" }, created_at: D("2026-04-10T10:00:00Z") };
      await sink.deliver(row);
      await sink.deliver(row); // redelivery after a crash between the Mongo write and the Postgres update
      await sink.deliver({ ...row, created_at: D("2026-05-10T10:00:00Z") }); // even a replay with other content changes nothing
      const col = eventsDb.collection(COLLECTIONS.activityEvents);
      assert.equal(await col.countDocuments(), 1);
      assert.deepEqual(await monthlyEvents(col), [{ month: "2026-04", type: "pull_request.status_changed", events: 1 }]);
    } finally {
      assert.match(`${dbName}_sink`, /^cc_analytics_test_[0-9a-f]{12}_sink$/);
      await eventsDb.dropDatabase();
    }
  });

  it("with the unique indexes from P2-09 in place, a duplicate commit_files document cannot even be inserted", async () => {
    const cdb = client.db(`${dbName}_idx`);
    try {
      for (const spec of INDEXES.filter((i) => i.collection === COLLECTIONS.commitFiles)) {
        await cdb.collection(spec.collection).createIndex(spec.keys, { name: spec.name, ...(spec.unique ? { unique: true } : {}) });
      }
      const col = cdb.collection(COLLECTIONS.commitFiles);
      await col.insertOne(commit("o/a", "s1", D("2026-01-31T23:30:00Z"), "u1", [f("a.js", 1, 1)]) as never);
      await assert.rejects(col.insertOne(commit("o/a", "s1", D("2026-01-31T23:30:00Z"), "u1", [f("a.js", 1, 1)]) as never), /E11000/);
      assert.equal((await monthlyActivity(col))[0].commits, 1);
    } finally {
      assert.match(`${dbName}_idx`, /^cc_analytics_test_[0-9a-f]{12}_idx$/);
      await cdb.dropDatabase();
    }
  });
});
