import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnalyticsArgs, parseDay } from "./analytics-data";

test("a report name is required and must be known", () => {
  for (const bad of [[], ["bogus"], ["--repo=a/b"]]) assert.throws(() => parseAnalyticsArgs(bad), /one of/);
  assert.equal(parseAnalyticsArgs(["monthly"]).report, "monthly");
});

test("valid options are parsed", () => {
  const a = parseAnalyticsArgs(["files", "--repo=pallets/flask", "--since=2026-01-01", "--until=2026-02-01", "--limit=7"]);
  assert.equal(a.repo, "pallets/flask");
  assert.equal(a.limit, 7);
  assert.equal(a.since?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(a.until?.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(parseAnalyticsArgs(["events", "--repository=12"]).repositoryId, "12");
});

test("dates must be real calendar days", () => {
  assert.equal(parseDay("2024-02-29", "d").toISOString(), "2024-02-29T00:00:00.000Z");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "26-01-01", "", "2026-01-01T00:00:00Z", "yesterday"]) assert.throws(() => parseDay(bad, "d"), /YYYY-MM-DD/, bad);
});

test("unknown flags, bad values and mixed-up filters are rejected", () => {
  for (const bad of [["monthly", "--nope"], ["monthly", "--repo=bad"], ["monthly", "--repo="], ["files", "--limit=0"], ["files", "--limit=501"], ["files", "--limit=x"],
    ["events", "--repository=0"], ["events", "--repository=1; DROP"], ["monthly", "--since"]]) {
    assert.throws(() => parseAnalyticsArgs(bad), /Unsupported|YYYY|one of/, JSON.stringify(bad));
  }
  assert.throws(() => parseAnalyticsArgs(["events", "--repo=a/b"]), /--repository/);
  assert.throws(() => parseAnalyticsArgs(["monthly", "--repository=3"]), /events only/);
});
