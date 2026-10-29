// Unit tests: they check the shape of the pipelines and the argument rules, not what MongoDB returns.
// The results of the pipelines are checked against a real MongoDB in scripts/mongo-analytics.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TOP_FILES, MAX_TOP_FILES, monthlyActivity, monthlyActivityPipeline, monthlyEvents, monthlyEventsPipeline, topFiles, topFilesPipeline,
  type Aggregatable, type Pipeline,
} from "./mongo-analytics";

const ops = (p: Pipeline) => p.map((s) => Object.keys(s)[0]);
const first = (p: Pipeline) => (p[0] as { $match: Record<string, unknown> }).$match;

test("monthly activity: guards, duplicate collapse, UTC month grouping, stable order", () => {
  const p = monthlyActivityPipeline();
  assert.deepEqual(ops(p), ["$match", "$group", "$replaceRoot", "$group", "$project", "$sort"]);
  assert.deepEqual(first(p).committedAt, { $type: "date" }); // malformed or missing timestamps never reach $dateToString
  assert.deepEqual(first(p).sha, { $type: "string" });
  assert.deepEqual(first(p).repo, { $type: "string" });
  assert.deepEqual((p[1] as { $group: { _id: unknown } }).$group._id, { repo: "$repo", sha: "$sha" });
  const group = JSON.stringify(p[3]);
  assert.match(group, /"format":"%Y-%m".*"timezone":"UTC"/);
  assert.match(group, /\$isArray/); // a missing or non-array `files` counts as zero files instead of failing $size
  assert.deepEqual(p.at(-1), { $sort: { month: 1, repo: 1 } });
});

test("filters are half-open on the date and exact on the repository", () => {
  const since = new Date("2026-02-01T00:00:00Z");
  const until = new Date("2026-03-01T00:00:00Z");
  const m = first(monthlyActivityPipeline({ repo: "pallets/flask", since, until }));
  assert.equal(m.repo, "pallets/flask");
  assert.deepEqual(m.committedAt, { $type: "date", $gte: since, $lt: until });
  assert.deepEqual(first(monthlyActivityPipeline({ since })).committedAt, { $type: "date", $gte: since });
});

test("invalid or reversed dates are refused instead of silently matching nothing", () => {
  const d = new Date("2026-02-01T00:00:00Z");
  assert.throws(() => monthlyActivityPipeline({ since: new Date("nope") }), RangeError);
  assert.throws(() => monthlyActivityPipeline({ since: d, until: d }), /before/);
  assert.throws(() => monthlyEventsPipeline({ since: new Date(d.getTime() + 1), until: d }), RangeError);
});

test("top files: only array files with a real name, duplicates collapsed, stable order, bounded limit", () => {
  const p = topFilesPipeline({ repo: "pallets/click" });
  assert.deepEqual(ops(p), ["$match", "$group", "$replaceRoot", "$unwind", "$match", "$group", "$sort", "$limit", "$project"]);
  assert.deepEqual(first(p).files, { $type: "array" });
  assert.deepEqual((p[4] as { $match: unknown }).$match, { "files.filename": { $type: "string", $ne: "" } });
  assert.deepEqual(p.find((s) => "$limit" in s), { $limit: DEFAULT_TOP_FILES });
  assert.deepEqual(p.find((s) => "$sort" in s), { $sort: { modifications: -1, "_id.repo": 1, "_id.filename": 1 } });
  assert.deepEqual(topFilesPipeline({}, 5).find((s) => "$limit" in s), { $limit: 5 });
  for (const bad of [0, -1, 1.5, MAX_TOP_FILES + 1, NaN, Infinity]) assert.throws(() => topFilesPipeline({}, bad), RangeError, String(bad));
  assert.doesNotThrow(() => topFilesPipeline({}, MAX_TOP_FILES));
});

test("events: one count per outbox id, UTC month, optional repository and type filters", () => {
  const p = monthlyEventsPipeline({ repositoryId: "4", type: "issue.status_changed" });
  assert.deepEqual(ops(p), ["$match", "$group", "$replaceRoot", "$group", "$project", "$sort"]);
  assert.equal(first(p).repositoryId, "4");
  assert.equal(first(p).type, "issue.status_changed");
  assert.deepEqual(first(p).outboxId, { $type: "string" });
  assert.deepEqual(first(p).occurredAt, { $type: "date" });
  assert.deepEqual((p[1] as { $group: { _id: unknown } }).$group._id, { outboxId: "$outboxId" });
  assert.match(JSON.stringify(p[3]), /"timezone":"UTC"/);
  assert.ok(!("repositoryId" in first(monthlyEventsPipeline())));
});

test("pipelines contain only fixed stages and bound values: a hostile repo name stays a plain string value", () => {
  const evil = "x\"}, {$out: \"commit_files\"}, {\"a\": \"";
  const p = monthlyActivityPipeline({ repo: evil });
  assert.equal(first(p).repo, evil);
  assert.ok(!ops(p).includes("$out") && !ops(p).includes("$merge")); // the analytics code never writes
  for (const pipe of [monthlyActivityPipeline(), topFilesPipeline(), monthlyEventsPipeline()]) assert.doesNotMatch(JSON.stringify(pipe), /"\$(?:out|merge|function|where)"/);
});

test("the runners pass the pipeline through and return the rows", async () => {
  const seen: Pipeline[] = [];
  const coll: Aggregatable = { aggregate: (p) => { seen.push(p); return { toArray: async () => [{ ok: 1 }] }; } };
  assert.deepEqual(await monthlyActivity(coll, { repo: "a/b" }), [{ ok: 1 }]);
  assert.deepEqual(await topFiles(coll, {}, 3), [{ ok: 1 }]);
  assert.deepEqual(await monthlyEvents(coll), [{ ok: 1 }]);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0], monthlyActivityPipeline({ repo: "a/b" }));
  assert.deepEqual(await monthlyActivity({ aggregate: () => ({ toArray: async () => [] }) }), []); // empty result
});

test("a filter value that is not a plain string is refused, so a query operator cannot be smuggled into $match", () => {
  const hostile: unknown[] = [{ $ne: null }, { $regex: ".*" }, { $gt: "" }, ["a/b"], 1, true, null, "", "a\0b"];
  for (const bad of hostile) {
    assert.throws(() => monthlyActivityPipeline({ repo: bad as string }), TypeError, JSON.stringify(bad));
    assert.throws(() => topFilesPipeline({ repo: bad as string }), TypeError, JSON.stringify(bad));
    assert.throws(() => monthlyEventsPipeline({ repositoryId: bad as string }), TypeError, JSON.stringify(bad));
    assert.throws(() => monthlyEventsPipeline({ type: bad as string }), TypeError, JSON.stringify(bad));
  }
  assert.equal(first(monthlyActivityPipeline({ repo: "$ne" })).repo, "$ne"); // a string that merely looks like an operator stays an exact value
  assert.equal(first(monthlyEventsPipeline({ repositoryId: "4" })).repositoryId, "4");
});
