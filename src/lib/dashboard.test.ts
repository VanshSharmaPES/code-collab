import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISTRIBUTION_SQL, NON_REVIEWERS_SQL, ROW_LIMIT, SCORE_STATS_SQL, STALE_DAYS, STALE_ISSUES_SQL, TOP_CONTRIBUTORS_SQL, getDashboard,
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
    assert.doesNotMatch(sql, /password|email|SELECT \*|\$\{/i);
    assert.doesNotMatch(sql, /\$[2-9]/); // the viewer is the only parameter
  }
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
  const d = await getDashboard("42", async (text, params) => { calls.push({ text, params }); return rows[text] ?? []; });
  assert.equal(calls.length, 5);
  for (const c of calls) assert.deepEqual(c.params, ["42"]);
  assert.deepEqual(d.buckets, []);
  assert.equal(d.stats.members, 0);
  const withData = await getDashboard("42", async (text) => (text === DISTRIBUTION_SQL ? [{ bucket: 1, from_score: 0, to_score: 10, members: 2 }] : text === SCORE_STATS_SQL ? [{ members: "2", min: "1" }] : []));
  assert.deepEqual(withData.buckets, [{ bucket: 1, from_score: 0, to_score: 10, members: 2 }]);
});
