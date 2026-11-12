import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACTIVITY_LIMIT, HOME_ACTIVITY_SQL, HOME_MY_CONTRIBUTIONS_SQL, HOME_PROJECTS_SQL, HOME_USER_SQL,
  activityHref, getHome, toActivityItem, toHomeProject, toMyContribution,
} from "./home";
import { managerSql, participantSql } from "./project-access";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("every query is limited to the viewer's projects or the viewer's own rows, with the viewer as the only bound parameter", () => {
  assert.ok(HOME_PROJECTS_SQL.includes(participantSql("$1", "d.project_id")));
  assert.ok(HOME_PROJECTS_SQL.includes(managerSql("$1", "d.project_id")));
  assert.equal(HOME_ACTIVITY_SQL.split(participantSql("$1", "r.project_id")).length - 1, 2, "both the issue and the pull request branch are scoped");
  assert.match(HOME_MY_CONTRIBUTIONS_SQL, /WHERE m\.user_id = \$1::bigint$/);
  assert.match(HOME_USER_SQL, /WHERE id = \$1::bigint$/);
  for (const sql of [HOME_USER_SQL, HOME_PROJECTS_SQL, HOME_MY_CONTRIBUTIONS_SQL, HOME_ACTIVITY_SQL]) {
    assert.doesNotMatch(sql, /password|email|SELECT \*\s+FROM (users|issues)|\$\{/i);
    assert.doesNotMatch(sql, /\$[2-9]/);
  }
});

test("the activity list is capped, and the cap written in the SQL is the exported one", () => {
  assert.equal(ACTIVITY_LIMIT, 8);
  assert.equal(HOME_ACTIVITY_SQL.match(/LIMIT (\d+)/g)?.length, 3);
  for (const m of HOME_ACTIVITY_SQL.matchAll(/LIMIT (\d+)/g)) assert.equal(Number(m[1]), ACTIVITY_LIMIT);
});

test("numbers that PostgreSQL returns as strings become numbers; missing values stay missing", () => {
  const mine = toMyContribution({ commits: "12", prs_opened: 4, prs_merged: "3", reviews_given: 2, issues_closed: null, score: "41.5" });
  assert.deepEqual(mine, { commits: 12, prs_opened: 4, prs_merged: 3, reviews_given: 2, issues_closed: 0, score: 41.5 });
  const p = toHomeProject({ project_id: 16, project_name: "A", project_status: "archived", mentor_name: null, members: "4", open_issues: "9", urgent_open_issues: "2",
    open_prs: "1", approved_prs: "0", merged_prs: "7", total_commits: "1000", commits_last_7_days: "0", last_commit_at: null, is_manager: true }, null);
  assert.equal(p.project_id, "16");
  assert.equal(p.archived, true);
  assert.equal(p.mentor_name, null);
  assert.equal(p.members, 4);
  assert.equal(p.total_commits, 1000);
  assert.equal(p.last_commit_at, null);
  assert.equal(p.is_manager, true);
  assert.equal(p.mine, null);
  assert.equal(toHomeProject({ project_id: 1, project_name: "B", project_status: "active", is_manager: "t" }, null).is_manager, false); // only a real true counts
});

test("an activity item links to its own page, and an unknown kind is treated as an issue, never as free text in the link", () => {
  assert.equal(activityHref(toActivityItem({ kind: "issue", id: 5, number: 1, title: "t", status: "open", updated_at: "2026-01-01", project_name: "A" })), "/issues/5");
  assert.equal(activityHref(toActivityItem({ kind: "pull_request", id: "8", number: 2, title: "t", status: "merged", updated_at: "2026-01-01", project_name: "A" })), "/pull-requests/8");
  assert.equal(toActivityItem({ kind: "../admin", id: 1, number: 1, title: "t", status: "open", updated_at: "x", project_name: "A" }).kind, "issue");
});

test("the overview runs four queries with the viewer, and joins each project to the viewer's own numbers", async () => {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    [HOME_USER_SQL]: [{ full_name: "Neel Das" }],
    [HOME_PROJECTS_SQL]: [{ project_id: "1", project_name: "A", project_status: "active", is_manager: false }, { project_id: "2", project_name: "B", project_status: "active", is_manager: true }],
    [HOME_MY_CONTRIBUTIONS_SQL]: [{ project_id: "1", commits: 5, prs_opened: 1, prs_merged: 1, reviews_given: 2, issues_closed: 0, score: 16 }],
    [HOME_ACTIVITY_SQL]: [{ kind: "issue", id: "3", number: 4, title: "t", status: "open", updated_at: "2026-01-02", project_name: "A" }],
  };
  const home = await getHome("42", async (text, params) => { calls.push({ text, params }); return rows[text] ?? []; });
  assert.equal(calls.length, 4);
  for (const c of calls) assert.deepEqual(c.params, ["42"]);
  assert.equal(home.name, "Neel Das");
  assert.equal(home.projects[0].mine?.score, 16);
  assert.equal(home.projects[1].mine, null); // a manager who is on no team there has no contribution of their own
  assert.equal(home.activity.length, 1);
});

test("a person with no project and no name gets an empty overview, not an error", async () => {
  const home = await getHome("7", async () => []);
  assert.deepEqual(home, { name: null, projects: [], activity: [] });
});

test("a database failure propagates so the page can show its error state", async () => {
  await assert.rejects(getHome("7", async () => { throw new Error("db down"); }), /db down/);
});

test("the home page checks the session itself, renders text as escaped children and sits behind a Suspense boundary", () => {
  const src = read("../app/page.tsx");
  assert.match(src, /await requireSession\(\)/);
  assert.match(src, /getHome\(session\.userId\)/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  assert.match(src, /<Suspense fallback=\{[^]*Loading your overview[^]*\}>\s*<HomeContent \/>/);
  assert.doesNotMatch(src, /Placeholder page/);
});

test("counts in the contribution line use the singular for exactly one", () => {
  const src = read("../app/page.tsx");
  assert.match(src, /const plural = \(n: number, word: string\): string => `\$\{n\} \$\{word\}\$\{n === 1 \? "" : "s"\}`/);
  assert.match(src, /plural\(p\.mine\.issues_closed, "issue"\)/);
  assert.doesNotMatch(src, /\{p\.mine\.issues_closed\} issues closed/);
});
