import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GET_PULL_REQUEST_SQL, LIST_PULL_REQUESTS_SQL, PAGE_SIZE, PullRequestMirroredError, PullRequestNotFoundError, PullRequestStatusError,
  TRANSITION_PULL_REQUEST_SQL, canChangePullRequest, countPullRequests, getPullRequest, listPullRequests, transitionPullRequest,
} from "./pull-requests";
import { ACTION_ERRORS, PR_ACTIONS, PR_STATUSES, availableActions, isPullRequestStatus, parsePullRequestAction } from "./pull-request-input";

test("no query selects user emails or password hashes, or uses SELECT *", () => {
  for (const sql of [LIST_PULL_REQUESTS_SQL, GET_PULL_REQUEST_SQL]) assert.doesNotMatch(sql, /password|email|\*/i);
});

test("filters and paging are bound parameters", async () => {
  let seen: readonly unknown[] = [];
  await listPullRequests({ repositoryId: "4", status: "open" }, 3, PAGE_SIZE, async (_t, p) => { seen = p; return []; });
  assert.deepEqual(seen, ["4", "open", PAGE_SIZE, 2 * PAGE_SIZE]);
  assert.equal(await countPullRequests({ repositoryId: null, status: null }, async () => [{ n: 7 }]), 7);
  assert.equal(await countPullRequests({ repositoryId: null, status: null }, async () => []), 0);
  assert.equal(await getPullRequest("5", async () => []), null);
});

test("the detail query returns the mirror flag that decides whether the actions show", () => {
  assert.match(GET_PULL_REQUEST_SQL, /\(r\.github_url IS NOT NULL\) AS is_mirrored/);
  assert.equal(canChangePullRequest({ is_mirrored: false }), true);
  assert.equal(canChangePullRequest({ is_mirrored: true }), false);
});

test("status values and actions are validated against fixed lists", () => {
  assert.deepEqual([...PR_STATUSES], ["open", "approved", "merged", "closed"]); // the schema's CHECK values
  assert.equal(isPullRequestStatus("approved"), true);
  assert.equal(isPullRequestStatus("in_progress"), false);
  assert.equal(parsePullRequestAction("merge"), "merge");
  for (const bad of ["", "delete", "MERGE", null, undefined, 1]) assert.equal(parsePullRequestAction(bad), null);
  for (const code of Object.keys(ACTION_ERRORS)) assert.ok(ACTION_ERRORS[code as keyof typeof ACTION_ERRORS].length > 0);
});

test("the offered actions follow the status; a merged pull request offers none", () => {
  assert.deepEqual(availableActions("open"), ["approve", "close"]);
  assert.deepEqual(availableActions("approved"), ["merge", "close"]);
  assert.deepEqual(availableActions("closed"), ["reopen"]);
  assert.deepEqual(availableActions("merged"), []);
  assert.equal(PR_ACTIONS.length, 4);
});

test("transition SQL: sets merge columns, records the audit actor, skips GitHub mirrors, and is a single statement", () => {
  assert.match(TRANSITION_PULL_REQUEST_SQL, /^WITH upd AS \(UPDATE pull_requests pr /);
  assert.equal(TRANSITION_PULL_REQUEST_SQL.split(";").length, 1);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /merged_at = CASE WHEN \$2::text = 'merged' THEN now\(\) ELSE pr\.merged_at END/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /merged_by = CASE WHEN \$2::text = 'merged' THEN \$4::bigint ELSE pr\.merged_by END/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /set_config\('codecollab\.actor_id', \$4::text, true\)/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /pr\.status = ANY\(\$3::text\[\]\)/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /r\.github_url IS NULL\) RETURNING pr\.id\)/);
});

test("transition passes id, target status, allowed current statuses and actor as parameters", async () => {
  let seen: readonly unknown[] = [];
  await transitionPullRequest("5", "merge", "9", async (_t, p) => { seen = p; return [{ id: "5", mirrored: false, status: "approved" }]; });
  assert.deepEqual(seen, ["5", "merged", ["approved"], "9"]);
  await transitionPullRequest("5", "close", "9", async (_t, p) => { seen = p; return [{ id: "5", mirrored: false, status: "open" }]; });
  assert.deepEqual(seen, ["5", "closed", ["open", "approved"], "9"]);
});

test("a failed transition says why: missing, GitHub mirror, or wrong status", async () => {
  await assert.rejects(transitionPullRequest("5", "approve", "9", async () => [{ id: null, mirrored: null, status: null }]), PullRequestNotFoundError);
  await assert.rejects(transitionPullRequest("5", "approve", "9", async () => []), PullRequestNotFoundError);
  await assert.rejects(transitionPullRequest("5", "approve", "9", async () => [{ id: null, mirrored: true, status: "open" }]), PullRequestMirroredError);
  await assert.rejects(
    transitionPullRequest("5", "merge", "9", async () => [{ id: null, mirrored: false, status: "open" }]),
    (err) => err instanceof PullRequestStatusError && err.current === "open",
  );
  const boom = new Error("boom");
  await assert.rejects(transitionPullRequest("5", "approve", "9", async () => { throw boom; }), (err) => err === boom);
});
