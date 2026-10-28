import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVE_PULL_REQUEST_SQL, COUNT_PULL_REQUESTS_SQL, GET_PULL_REQUEST_SQL, LIST_PULL_REQUESTS_SQL, MERGE_PULL_REQUEST_SQL, PAGE_SIZE, PULL_REQUEST_STATE_SQL,
  PullRequestMirroredError, PullRequestNotFoundError, PullRequestRuleError, PullRequestStatusError,
  TRANSITION_PULL_REQUEST_SQL, canChangePullRequest, countPullRequests, getPullRequest, listPullRequests, transitionPullRequest,
} from "./pull-requests";
import {
  ACTION_ERRORS, PR_ACTIONS, PR_STATUSES, approveErrorCode, availableActions, isPullRequestStatus, mergeErrorCode, parsePullRequestAction,
} from "./pull-request-input";
import { config as proxyConfig } from "../proxy";
import { managerSql, participantSql } from "./project-access";

test("no query selects user emails or password hashes, or uses SELECT *", () => {
  for (const sql of [LIST_PULL_REQUESTS_SQL, GET_PULL_REQUEST_SQL]) assert.doesNotMatch(sql, /password|email|\*/i);
});

test("filters and paging are bound parameters", async () => {
  let seen: readonly unknown[] = [];
  await listPullRequests({ repositoryId: "4", status: "open" }, 3, PAGE_SIZE, "77", async (_t, p) => { seen = p; return []; });
  assert.deepEqual(seen, ["4", "open", PAGE_SIZE, 2 * PAGE_SIZE, "77"]); // the last one is the viewer
  assert.equal(await countPullRequests({ repositoryId: null, status: null }, "77", async () => [{ n: 7 }]), 7);
  assert.equal(await countPullRequests({ repositoryId: null, status: null }, "77", async () => []), 0);
  assert.equal(await getPullRequest("5", "77", async () => []), null);
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

// ---- close and reopen: the plain status change

test("close/reopen SQL: audit actor, mirror guard, one statement, and it can never produce merged or approved", () => {
  assert.match(TRANSITION_PULL_REQUEST_SQL, /^WITH upd AS \(UPDATE pull_requests pr /);
  assert.equal(TRANSITION_PULL_REQUEST_SQL.split(";").length, 1);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /set_config\('codecollab\.actor_id', \$4::text, true\)/);
  assert.match(TRANSITION_PULL_REQUEST_SQL, /pr\.status = ANY\(\$3::text\[\]\)/);
  // Only a manager (mentor or team lead) or the author, who must still take part in the project, can close or reopen.
  assert.ok(TRANSITION_PULL_REQUEST_SQL.includes(`r.github_url IS NULL AND (${managerSql("$4", "r.project_id")} OR (pr.author_id = $4::bigint AND ${participantSql("$4", "r.project_id")}))) RETURNING pr.id)`));
  // A pull request of a project the actor takes no part in is reported as missing (status stays NULL).
  assert.ok(TRANSITION_PULL_REQUEST_SQL.includes(`WHERE x.id = $1::bigint AND ${participantSql("$4", "r.project_id")}) AS status`));
  assert.match(TRANSITION_PULL_REQUEST_SQL, /\$2::text IN \('open', 'closed'\)/);
  assert.doesNotMatch(TRANSITION_PULL_REQUEST_SQL, /merged/); // no merge columns: merging is the procedure's job
});

test("close passes id, target status, allowed current statuses and actor as parameters", async () => {
  let seen: readonly unknown[] = [];
  await transitionPullRequest("5", "close", "9", async (_t, p) => { seen = p; return [{ id: "5", mirrored: false, status: "open" }]; });
  assert.deepEqual(seen, ["5", "closed", ["open", "approved"], "9"]);
  await transitionPullRequest("5", "reopen", "9", async (_t, p) => { seen = p; return [{ id: "5" }]; });
  assert.deepEqual(seen, ["5", "open", ["closed"], "9"]);
});

test("a failed close says why: missing, GitHub mirror, or wrong status", async () => {
  await assert.rejects(transitionPullRequest("5", "close", "9", async () => [{ id: null, mirrored: null, status: null }]), PullRequestNotFoundError);
  await assert.rejects(transitionPullRequest("5", "close", "9", async () => []), PullRequestNotFoundError);
  await assert.rejects(transitionPullRequest("5", "close", "9", async () => [{ id: null, mirrored: true, status: "open" }]), PullRequestMirroredError);
  await assert.rejects(
    transitionPullRequest("5", "reopen", "9", async () => [{ id: null, mirrored: false, status: "open" }]),
    (err) => err instanceof PullRequestStatusError && err.current === "open",
  );
  const boom = new Error("boom");
  await assert.rejects(transitionPullRequest("5", "close", "9", async () => { throw boom; }), (err) => err === boom);
});

// ---- approve: a real review

type Call = { text: string; params: readonly unknown[] };
const script = (answers: Record<string, unknown[] | Error>) => {
  const calls: Call[] = [];
  const run = (async (text: string, params: readonly unknown[]) => {
    calls.push({ text, params });
    const answer = answers[text] ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as never;
  return { calls, run };
};
const pgError = (code: string, message = "db") => Object.assign(new Error(message), { code });

test("approve writes a pr_reviews row and updates the status in the same statement, with the reviewer and actor", async () => {
  assert.match(APPROVE_PULL_REQUEST_SQL, /^WITH rev AS \(INSERT INTO pr_reviews \(pull_request_id, reviewer_id, verdict\) SELECT pr\.id, \$2::bigint, 'approved'/);
  assert.ok(APPROVE_PULL_REQUEST_SQL.includes(`pr.status IN ('open', 'approved') AND r.github_url IS NULL AND ${participantSql("$2", "r.project_id")} RETURNING pull_request_id)`)); // only participants can review
  assert.match(APPROVE_PULL_REQUEST_SQL, /UPDATE pull_requests pr SET status = 'approved', updated_at = now\(\) FROM rev, \(SELECT set_config\('codecollab\.actor_id', \$2::text, true\)\) AS actor WHERE pr\.id = rev\.pull_request_id AND pr\.status = 'open'/);
  assert.equal(APPROVE_PULL_REQUEST_SQL.split(";").length, 1);
  const { calls, run } = script({ [APPROVE_PULL_REQUEST_SQL]: [{ reviewed: "5", updated: "5" }] });
  await transitionPullRequest("5", "approve", "9", run);
  assert.deepEqual(calls, [{ text: APPROVE_PULL_REQUEST_SQL, params: ["5", "9"] }]); // the status is never changed on its own
});

test("approving an already approved pull request adds the review and counts as success, not a false failure", async () => {
  const { calls, run } = script({ [APPROVE_PULL_REQUEST_SQL]: [{ reviewed: "5", updated: null }] });
  await transitionPullRequest("5", "approve", "9", run);
  assert.equal(calls.length, 1);
});

test("self-approval (check_violation 23514) becomes the self-approval message", async () => {
  const { run } = script({ [APPROVE_PULL_REQUEST_SQL]: pgError("23514", 'user 9 cannot review their own pull request 5') });
  await assert.rejects(transitionPullRequest("5", "approve", "9", run), (err) =>
    err instanceof PullRequestRuleError && err.code === "selfApproval" && ACTION_ERRORS[err.code] === "You can't approve your own pull request.");
  assert.equal(approveErrorCode("23514"), "selfApproval");
});

test("a second review by the same person (unique_violation 23505) becomes the already-reviewed message", async () => {
  const { run } = script({ [APPROVE_PULL_REQUEST_SQL]: pgError("23505") });
  await assert.rejects(transitionPullRequest("5", "approve", "9", run), (err) =>
    err instanceof PullRequestRuleError && err.code === "alreadyReviewed" && ACTION_ERRORS[err.code] === "You have already reviewed this pull request.");
  assert.equal(approveErrorCode("23505"), "alreadyReviewed");
});

test("other database errors during approval are passed through, not turned into a rule message", async () => {
  const boom = pgError("57014", "timeout");
  await assert.rejects(transitionPullRequest("5", "approve", "9", script({ [APPROVE_PULL_REQUEST_SQL]: boom }).run), (err) => err === boom);
  for (const code of [undefined, "", "23503", "42501", 23514]) assert.equal(approveErrorCode(code), null, String(code));
});

test("when no review was written, approve explains why: missing, GitHub mirror, or a status that cannot be approved", async () => {
  const none = { [APPROVE_PULL_REQUEST_SQL]: [{ reviewed: null, updated: null }] };
  await assert.rejects(transitionPullRequest("5", "approve", "9", script({ ...none, [PULL_REQUEST_STATE_SQL]: [] }).run), PullRequestNotFoundError);
  await assert.rejects(transitionPullRequest("5", "approve", "9", script({ ...none, [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: true, status: "open" }] }).run), PullRequestMirroredError);
  await assert.rejects(
    transitionPullRequest("5", "approve", "9", script({ ...none, [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: false, status: "merged" }] }).run),
    (err) => err instanceof PullRequestStatusError && err.current === "merged",
  );
});

// ---- merge: the procedure does everything

test("merge calls merge_pull_request with the pull request and the merger, and never updates the status itself", async () => {
  assert.equal(MERGE_PULL_REQUEST_SQL, "CALL merge_pull_request($1::bigint, $2::bigint)");
  const { calls, run } = script({ [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: false, status: "approved" }] });
  await transitionPullRequest("5", "merge", "9", run);
  assert.deepEqual(calls, [{ text: PULL_REQUEST_STATE_SQL, params: ["5", "9"] }, { text: MERGE_PULL_REQUEST_SQL, params: ["5", "9"] }]);
  for (const c of calls) assert.doesNotMatch(c.text, /UPDATE\s+pull_requests/i);
});

test("a pull request of a GitHub mirror is refused before the procedure is called", async () => {
  const { calls, run } = script({ [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: true, status: "approved" }] });
  await assert.rejects(transitionPullRequest("5", "merge", "9", run), PullRequestMirroredError);
  assert.ok(!calls.some((c) => c.text === MERGE_PULL_REQUEST_SQL));
  const missing = script({ [PULL_REQUEST_STATE_SQL]: [] });
  await assert.rejects(transitionPullRequest("5", "merge", "9", missing.run), PullRequestNotFoundError);
  assert.ok(!missing.calls.some((c) => c.text === MERGE_PULL_REQUEST_SQL));
});

test("every message the procedure can raise is shown as a failure with its own fixed message; success is never reported", async () => {
  const cases: [string, string][] = [
    ['merge_pull_request: pull request 5 is "open", only approved pull requests can be merged', "status"],
    ["merge_pull_request: pull request 5 has no approving review", "noApproval"],
    ["merge_pull_request: pull request 5 has an unresolved change request", "changesRequested"],
    ["merge_pull_request: project 3 is archived, merging is disabled", "projectInactive"],
    ["merge_pull_request: user 9 is not a lead or mentor of project 3", "notMerger"],
    ["merge_pull_request: simulated failure after all writes (demo)", "mergeRefused"],
    ["merge_pull_request: something new we have not seen", "mergeRefused"],
  ];
  for (const [message, expected] of cases) {
    const { run } = script({ [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: false, status: "open" }], [MERGE_PULL_REQUEST_SQL]: new Error(message) });
    let result = "resolved";
    try { await transitionPullRequest("5", "merge", "9", run); } catch (err) {
      result = err instanceof PullRequestStatusError ? "status" : err instanceof PullRequestRuleError ? err.code : "other";
    }
    assert.equal(result, expected, message);
    assert.equal(mergeErrorCode(message), expected, message);
  }
  assert.equal(mergeErrorCode("merge_pull_request: pull request 5 does not exist"), null);
  const { run } = script({ [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: false, status: "approved" }], [MERGE_PULL_REQUEST_SQL]: new Error("merge_pull_request: pull request 5 does not exist") });
  await assert.rejects(transitionPullRequest("5", "merge", "9", run), PullRequestNotFoundError);
});

test("an error that is not from the procedure is not shown as a merge rule; it is passed through", async () => {
  const boom = pgError("57P01", "terminating connection");
  await assert.rejects(
    transitionPullRequest("5", "merge", "9", script({ [PULL_REQUEST_STATE_SQL]: [{ id: null, mirrored: false, status: "approved" }], [MERGE_PULL_REQUEST_SQL]: boom }).run),
    (err) => err === boom,
  );
  assert.equal(mergeErrorCode("no prefix at all"), "failed");
});

test("the database text never reaches the page: every code used has a fixed message", () => {
  for (const code of ["selfApproval", "alreadyReviewed", "noApproval", "changesRequested", "projectInactive", "notMerger", "mergeRefused", "status", "mirrored", "failed"] as const) {
    assert.ok(ACTION_ERRORS[code].length > 0 && !/merge_pull_request|SQLSTATE|ERROR/i.test(ACTION_ERRORS[code]), code);
  }
});

// ---- the proxy

test("the proxy protects issues, pull requests and users, and leaves the home page and the auth and health APIs public", () => {
  const m = proxyConfig.matcher;
  for (const path of ["/issues", "/issues/:path*", "/pull-requests", "/pull-requests/:path*", "/users", "/users/:path*"]) assert.ok(m.includes(path), path);
  for (const path of ["/", "/api/:path*", "/api/auth/login", "/api/health/db", "/(.*)", "/:path*"]) assert.ok(!m.includes(path), `${path} must stay public`);
});

// ---- who may act

test("a pull request of a project the actor takes no part in looks like a missing one, for every action", async () => {
  const hidden = { [PULL_REQUEST_STATE_SQL]: [], [TRANSITION_PULL_REQUEST_SQL]: [{ id: null, mirrored: null, status: null, permitted: null }], [APPROVE_PULL_REQUEST_SQL]: [{ reviewed: null, updated: null }] };
  for (const action of ["approve", "merge", "close", "reopen"] as const) {
    const { calls, run } = script(hidden);
    await assert.rejects(transitionPullRequest("5", action, "9", run), PullRequestNotFoundError, action);
    assert.ok(!calls.some((c) => c.text === MERGE_PULL_REQUEST_SQL), "the merge procedure is not called for a hidden pull request");
  }
});

test("a participant who is neither the author nor a manager cannot close or reopen, and is told so", async () => {
  const denied = script({ [TRANSITION_PULL_REQUEST_SQL]: [{ id: null, mirrored: false, status: "open", permitted: false }] });
  await assert.rejects(transitionPullRequest("5", "close", "9", denied.run), (err) =>
    err instanceof PullRequestRuleError && err.code === "forbidden" && /author, a team lead or the mentor/.test(ACTION_ERRORS[err.code]));
  const allowed = script({ [TRANSITION_PULL_REQUEST_SQL]: [{ id: "5", mirrored: false, status: "open", permitted: true }] });
  await transitionPullRequest("5", "close", "9", allowed.run);
  // a wrong status for someone who may act is still reported as a status problem, not as forbidden
  await assert.rejects(transitionPullRequest("5", "reopen", "9", script({ [TRANSITION_PULL_REQUEST_SQL]: [{ id: null, mirrored: false, status: "open", permitted: true }] }).run), PullRequestStatusError);
});

test("the pull request list, count and detail queries only return projects the viewer takes part in", () => {
  assert.ok(LIST_PULL_REQUESTS_SQL.includes(participantSql("$5", "r.project_id")));
  assert.ok(COUNT_PULL_REQUESTS_SQL.includes(participantSql("$3", "r.project_id")));
  assert.ok(GET_PULL_REQUEST_SQL.includes(participantSql("$2", "r.project_id")));
  assert.ok(PULL_REQUEST_STATE_SQL.includes(participantSql("$2", "r.project_id")));
});
