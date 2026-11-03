import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISTRIBUTION_SQL, NON_REVIEWERS_SQL, ROW_LIMIT, SCORE_STATS_SQL, STALE_DAYS, STALE_ISSUES_SQL, TOP_CONTRIBUTORS_SQL, allScoresEqual, getDashboard, isCapped,
  toBucket, toNonReviewer, toStaleIssue, toStats, toTopContributor,
} from "./dashboard";
import { managerSql } from "./project-access";

test("every dashboard query is limited to projects the viewer manages, with the viewer as a bound parameter", () => {
  assert.ok(TOP_CONTRIBUTORS_SQL.includes(managerSql("$1", "m.project_id")));
  assert.ok(STALE_ISSUES_SQL.includes(managerSql("$1", "p.id")));
  assert.ok(NON_REVIEWERS_SQL.includes(managerSql("$1", "p.id")));
  assert.ok(DISTRIBUTION_SQL.includes(managerSql("$1", "m.project_id")));
  assert.ok(SCORE_STATS_SQL.includes(managerSql("$1", "m.project_id")));
  for (const sql of [TOP_CONTRIBUTORS_SQL, STALE_ISSUES_SQL, NON_REVIEWERS_SQL, DISTRIBUTION_SQL, SCORE_STATS_SQL]) {
    // No credentials, and no star of any kind (`SELECT *`, `SELECT m.*`): a column added to a view later must not reach the page.
    assert.doesNotMatch(sql, /password|email|SELECT\s+(?:\w+\.)?\*|,\s*(?:\w+\.)?\*\s*,/i);
    assert.doesNotMatch(sql, /\$\{|undefined|\[object/); // an unexpanded or broken interpolation would show up in the text
    assert.doesNotMatch(sql, /\$[2-9]/); // the viewer is the only parameter
  }
});

test("the histogram edges keep one decimal, so a narrow score range does not produce equal or overlapping labels", () => {
  assert.match(DISTRIBUTION_SQL, /\/ 8, 1\) AS from_score/);
  assert.match(DISTRIBUTION_SQL, /\/ 8, 1\) AS to_score/);
  assert.doesNotMatch(DISTRIBUTION_SQL, /\/ 8, 0\)/);
  assert.match(SCORE_STATS_SQL, /min\(score\)::numeric\(10,1\) AS min/);
  assert.match(SCORE_STATS_SQL, /max\(score\)::numeric\(10,1\) AS max/);
});

test("one line replaces the histogram only when every score is the same", () => {
  const stats = (members: number, min: number | null, max: number | null) => toStats({ members, min, max });
  assert.equal(allScoresEqual(stats(6, 8, 8)), true);
  assert.equal(allScoresEqual(stats(6, 0, 5)), false);
  assert.equal(allScoresEqual(stats(0, null, null)), false, "no members: nothing to say");
  assert.equal(allScoresEqual(stats(1, 4, 4)), true);
});

test("a list says it was cut off only when it has reached the row limit", () => {
  assert.equal(isCapped(0), false);
  assert.equal(isCapped(3), false);
  assert.equal(isCapped(ROW_LIMIT - 1), false);
  assert.equal(isCapped(ROW_LIMIT), true);
});

test("top contributors are ordered by numeric project_id, then rank, then numeric user_id", () => {
  assert.match(TOP_CONTRIBUTORS_SQL, /ORDER BY project_id::bigint, rank, user_id::bigint$/);
});

test("the queries keep the P1-13 definitions: top three by rank, stale after 14 days for high and critical, anti-join, eight buckets", () => {
  assert.match(TOP_CONTRIBUTORS_SQL, /RANK\(\) OVER \(PARTITION BY m\.project_id ORDER BY m\.score DESC\)/);
  assert.match(TOP_CONTRIBUTORS_SQL, /WHERE rank <= 3/);
  assert.equal(STALE_DAYS, 14);
  assert.match(STALE_ISSUES_SQL, /i\.priority IN \('high', 'critical'\)/);
  assert.match(STALE_ISSUES_SQL, /i\.status IN \('open', 'in_progress'\)/);
  assert.match(STALE_ISSUES_SQL, /interval '14 days'/);
  assert.match(NON_REVIEWERS_SQL, /WHERE reviewed\.reviewer_id IS NULL/);
  assert.match(DISTRIBUTION_SQL, /width_bucket\(s\.score, b\.lo, b\.hi, 8\)/);
  assert.match(DISTRIBUTION_SQL, /generate_series\(1, 8\)/);
  assert.match(SCORE_STATS_SQL, /percentile_cont\(0\.50\)/);
  for (const sql of [STALE_ISSUES_SQL, NON_REVIEWERS_SQL]) assert.match(sql, new RegExp(`LIMIT ${ROW_LIMIT}$`));
});

test("numbers that PostgreSQL returns as strings become numbers; missing values stay missing", () => {
  assert.deepEqual(toTopContributor({ project_id: 1, project_name: "A", rank: "2", user_id: 9, full_name: "N", score: "33.00", pct_of_project: "12.5" }),
    { project_id: "1", project_name: "A", rank: 2, user_id: "9", full_name: "N", score: 33, pct_of_project: 12.5 });
  assert.equal(toTopContributor({ project_id: 1, project_name: "A", rank: 1, user_id: 1, full_name: "N", score: 0, pct_of_project: null }).pct_of_project, null);
  assert.equal(toStaleIssue({ project_id: 1, project_name: "A", issue_id: 3, number: 7, title: "t", priority: "high", status: "open", assignee: null, days_since_update: "20" }).assignee, null);
  assert.equal(toNonReviewer({ project_id: 1, project_name: "A", user_id: 2, full_name: "N", user_role: "student", commits: "40", prs_opened: "3" }).commits, 40);
  assert.deepEqual(toBucket({ bucket: 1, from_score: null, to_score: null, members: "0" }), { bucket: 1, from_score: null, to_score: null, members: 0 });
  assert.deepEqual(toStats(undefined), { members: 0, min: null, p25: null, median: null, p75: null, p90: null, max: null, mean: null, stddev: null });
  assert.equal(toStats({ members: "6", median: "12.5" }).median, 12.5);
});

test("the dashboard runs the five queries with the viewer, and shows no histogram when the viewer manages no members", async () => {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    [DISTRIBUTION_SQL]: Array.from({ length: 8 }, (_, i) => ({ bucket: i + 1, from_score: null, to_score: null, members: 0 })),
    [SCORE_STATS_SQL]: [{ members: "0", min: null }],
  };
  const known = new Set([TOP_CONTRIBUTORS_SQL, STALE_ISSUES_SQL, NON_REVIEWERS_SQL, DISTRIBUTION_SQL, SCORE_STATS_SQL]);
  // A query this test does not know fails loudly instead of quietly returning no rows.
  const d = await getDashboard("42", async (text, params) => { assert.ok(known.has(text), `unexpected query: ${text.slice(0, 60)}`); calls.push({ text, params }); return rows[text] ?? []; });
  assert.equal(calls.length, 5);
  for (const c of calls) assert.deepEqual(c.params, ["42"]);
  assert.deepEqual(d.buckets, []);
  assert.equal(d.stats.members, 0);
  const withData = await getDashboard("42", async (text) => (text === DISTRIBUTION_SQL ? [{ bucket: 1, from_score: 0, to_score: 10, members: 2 }] : text === SCORE_STATS_SQL ? [{ members: "2", min: "1" }] : []));
  assert.deepEqual(withData.buckets, [{ bucket: 1, from_score: 0, to_score: 10, members: 2 }]);
});
