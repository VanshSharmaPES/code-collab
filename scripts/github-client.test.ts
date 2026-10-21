import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { GitHubError, createGitHubClient, parseLinkHeader, type FetchLike } from "./github-client";

// Random per run: no real credential appears in the repository.
const token = `tok_${randomBytes(12).toString("hex")}`;

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

// A scripted fetch: returns the queued responses in order and records every request.
function scripted(queue: Scripted[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const events: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    events.push(`fetch ${url}`);
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request in test");
    if (next instanceof Error) throw next;
    const body = next.body === undefined ? "[]" : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return { status: next.status, headers: new Headers(next.headers ?? {}), text: async () => body };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    events.push(`sleep ${ms}`);
  };
  return { fetchFn, requests, sleeps, sleep, events };
}

const NOW = 1_000_000; // ms
const client = (s: ReturnType<typeof scripted>, extra: Partial<Parameters<typeof createGitHubClient>[0]> = {}) =>
  createGitHubClient({ token, fetch: s.fetchFn, sleep: s.sleep, now: () => NOW, random: () => 1, maxRetries: 3, baseDelayMs: 100, ...extra });

test("parseLinkHeader reads next and last, and tolerates junk", () => {
  const header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
  assert.deepEqual(parseLinkHeader(header), { next: "https://api.github.com/x?page=2", last: "https://api.github.com/x?page=9" });
  assert.deepEqual(parseLinkHeader(null), {});
  assert.deepEqual(parseLinkHeader("garbage"), {});
});

test("sends the version, user agent and bearer token; omits Authorization without a token", async () => {
  const s = scripted([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }]);
  await client(s).getJson("/repos/o/r");
  await createGitHubClient({ fetch: s.fetchFn, sleep: s.sleep }).getJson("/repos/o/r");
  assert.equal(s.requests[0].url, "https://api.github.com/repos/o/r");
  assert.equal(s.requests[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(s.requests[0].headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(s.requests[0].headers["User-Agent"], "codecollab-ingest");
  assert.ok(!("Authorization" in s.requests[1].headers));
  assert.ok(!s.requests[0].url.includes(token), "the token is never put in a URL");
});

test("paginate follows Link rel=next across pages and stops at the last one", async () => {
  const s = scripted([
    { status: 200, body: [1, 2], headers: { link: '<https://api.github.com/items?page=2>; rel="next"' } },
    { status: 200, body: [3, 4], headers: { link: '<https://api.github.com/items?page=3>; rel="next"' } },
    { status: 200, body: [5] },
  ]);
  const pages: unknown[][] = [];
  for await (const page of client(s).paginate("/items?per_page=2")) pages.push(page);
  assert.deepEqual(pages, [[1, 2], [3, 4], [5]]);
  assert.deepEqual(s.requests.map((r) => r.url), [
    "https://api.github.com/items?per_page=2",
    "https://api.github.com/items?page=2",
    "https://api.github.com/items?page=3",
  ]);
});

test("paginate rejects a non-list response", async () => {
  const s = scripted([{ status: 200, body: { not: "a list" } }]);
  await assert.rejects(async () => {
    for await (const page of client(s).paginate("/items")) void page;
  }, /Expected a list/);
});

test("the token is never sent anywhere except https://api.github.com", async () => {
  const bad = [
    "https://evil.example/steal",
    "http://api.github.com/repos/o/r",
    "https://api.github.com.evil.example/repos/o/r",
    "https://api.github.com@evil.example/repos/o/r",
    "https://user:pw@api.github.com/repos/o/r",
    "not a url",
  ];
  for (const url of bad) {
    const s = scripted([{ status: 200, body: {} }]);
    await assert.rejects(client(s).getJson(url), (err: Error) => err instanceof GitHubError && !err.message.includes(token), url);
    assert.equal(s.requests.length, 0, `no request was made for ${url}`);
  }
});

test("a Link next pointing at another host is refused before any request to it", async () => {
  const s = scripted([{ status: 200, body: [1], headers: { link: '<https://evil.example/page2>; rel="next"' } }]);
  await assert.rejects(async () => {
    for await (const page of client(s).paginate("/items")) void page;
  }, /outside https:\/\/api\.github\.com/);
  assert.equal(s.requests.length, 1);
});

test("same-host redirects are followed; cross-host and endless redirects are refused", async () => {
  const ok = scripted([
    { status: 301, headers: { location: "https://api.github.com/repositories/42" } },
    { status: 200, body: { id: 42 } },
  ]);
  assert.deepEqual((await client(ok).getJson("/repos/old/name")).data, { id: 42 });
  assert.equal(ok.requests[1].url, "https://api.github.com/repositories/42");

  const cross = scripted([{ status: 302, headers: { location: "https://evil.example/x" } }]);
  await assert.rejects(client(cross).getJson("/repos/o/r"), /outside https:\/\/api\.github\.com/);
  assert.equal(cross.requests.length, 1, "the token was not sent to the other host");

  const loop = scripted(Array.from({ length: 6 }, () => ({ status: 307, headers: { location: "/repos/o/r" } })));
  await assert.rejects(client(loop).getJson("/repos/o/r"), /redirects/);
});

test("a spent rate-limit budget makes the next request wait for the reset first", async () => {
  const resetSeconds = NOW / 1000 + 30;
  const s = scripted([
    { status: 200, body: [], headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) } },
    { status: 200, body: [] },
  ]);
  const c = client(s);
  await c.getJson("/a");
  await c.getJson("/b");
  assert.deepEqual(s.events, ["fetch https://api.github.com/a", "sleep 31000", "fetch https://api.github.com/b"]);
});

test("plenty of budget means no waiting", async () => {
  const s = scripted([
    { status: 200, headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String(NOW / 1000 + 3000) } },
    { status: 200 },
  ]);
  const c = client(s);
  await c.getJson("/a");
  await c.getJson("/b");
  assert.deepEqual(s.sleeps, []);
});

test("403 with an exhausted limit waits for the reset and retries; 429 honours Retry-After", async () => {
  const exhausted = scripted([
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 10) } },
    { status: 200, body: { ok: 1 } },
  ]);
  assert.deepEqual((await client(exhausted).getJson("/a")).data, { ok: 1 });
  assert.deepEqual(exhausted.sleeps, [11000]);

  const secondary = scripted([{ status: 429, headers: { "retry-after": "7" } }, { status: 200, body: { ok: 2 } }]);
  assert.deepEqual((await client(secondary).getJson("/a")).data, { ok: 2 });
  assert.deepEqual(secondary.sleeps, [7000]);
});

test("rate-limit waits are bounded", async () => {
  const s = scripted(Array.from({ length: 10 }, () => ({ status: 429, headers: { "retry-after": "1" } })));
  await assert.rejects(client(s, { maxRateLimitWaits: 2 }).getJson("/a"), (err: GitHubError) => err.status === 429);
  assert.equal(s.requests.length, 3);
});

test("a 403 that is not about rate limits fails at once without retrying", async () => {
  const s = scripted([{ status: 403, body: { message: "Resource not accessible" } }]);
  await assert.rejects(client(s).getJson("/repos/o/r"), (err: GitHubError) => err.status === 403 && /403/.test(err.message));
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.sleeps, []);
});

test("5xx responses retry with exponential backoff, then succeed", async () => {
  const s = scripted([{ status: 502 }, { status: 503 }, { status: 200, body: { ok: true } }]);
  assert.deepEqual((await client(s).getJson("/a")).data, { ok: true });
  assert.deepEqual(s.sleeps, [100, 200]);
});

test("persistent 5xx gives up after maxRetries and reports the status", async () => {
  const s = scripted(Array.from({ length: 10 }, () => ({ status: 500 })));
  await assert.rejects(client(s).getJson("/a"), (err: GitHubError) => err.status === 500);
  assert.equal(s.requests.length, 4, "1 attempt + 3 retries");
});

test("network errors retry, and the final error leaks nothing", async () => {
  const flaky = scripted([new Error(`socket hang up ${token}`), { status: 200, body: { ok: true } }]);
  assert.deepEqual((await client(flaky).getJson("/a")).data, { ok: true });

  const down = scripted(Array.from({ length: 10 }, () => new Error(`ECONNRESET ${token}`)));
  await assert.rejects(client(down).getJson("/repos/o/r?secret=1"), (err: Error) => {
    return /network error/.test(err.message) && !err.message.includes(token) && !err.message.includes("secret=1");
  });
  assert.equal(down.requests.length, 4);
});

test("4xx errors are not retried and mention only the status and path", async () => {
  const s = scripted([{ status: 404, body: { message: "Not Found" } }]);
  await assert.rejects(client(s).getJson("/repos/o/missing?page=2"), (err: GitHubError) => {
    return err.status === 404 && err.message === "GitHub API error 404 for /repos/o/missing." && !err.message.includes(token);
  });
  assert.equal(s.requests.length, 1);
});

test("invalid JSON is an error; an empty body is null", async () => {
  await assert.rejects(client(scripted([{ status: 200, body: "{nope" }])).getJson("/a"), /invalid JSON/);
  assert.equal((await client(scripted([{ status: 204, body: "" }])).getJson("/a")).data, null);
});

test("requestCount counts every attempt, retries included", async () => {
  const s = scripted([{ status: 500 }, { status: 200 }]);
  const c = client(s);
  await c.getJson("/a");
  assert.equal(c.requestCount, 2);
});

// ---- clock skew: a local clock that disagrees with GitHub's must not cause a busy loop ----

const RESET_MS = NOW + 30_000; // GitHub's window resets 30 s after GitHub's "now" (= NOW)
const exhausted = (extra: Record<string, string> = {}) => ({
  "x-ratelimit-remaining": "0",
  "x-ratelimit-reset": String(RESET_MS / 1000),
  ...extra,
});
const githubDate = new Date(NOW).toUTCString(); // what GitHub's Date header says (second precision)
const AHEAD = NOW + 600_000; // the local clock is 10 minutes ahead of GitHub
const BEHIND = NOW - 600_000; // the local clock is 10 minutes behind GitHub

test("clock ahead, no Date header: an exhausted 403 waits a conservative minimum instead of retrying at once", async () => {
  const s = scripted([{ status: 403, headers: exhausted() }, { status: 200, body: { ok: true } }]);
  const result = await client(s, { now: () => AHEAD }).getJson("/a");
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(s.sleeps, [60_000], "the computed wait was negative, so the 60 s floor applies");
  assert.deepEqual(s.events.map((e) => e.split(" ")[0]), ["fetch", "sleep", "fetch"], "it slept before retrying");
});

test("clock ahead, the limit stays exhausted: bounded retries, each one waiting, then a clear failure", async () => {
  const s = scripted(Array.from({ length: 20 }, () => ({ status: 403, headers: exhausted() })));
  await assert.rejects(client(s, { now: () => AHEAD }).getJson("/a"), (err: GitHubError) => err.status === 403 && /rate limit still exceeded/.test(err.message));
  assert.equal(s.requests.length, 6, "1 request + 5 allowed waits, then it stops");
  assert.deepEqual(s.sleeps, [60_000, 60_000, 60_000, 60_000, 60_000], "no retry happens without a wait");
});

test("clock ahead, with GitHub's Date header: the real remaining time is used, not zero", async () => {
  const s = scripted([{ status: 403, headers: exhausted({ date: githubDate }) }, { status: 200, body: { ok: true } }]);
  await client(s, { now: () => AHEAD }).getJson("/a");
  assert.deepEqual(s.sleeps, [31_000], "30 s until the reset plus the 1 s margin");
});

test("clock ahead, a successful response that reports a spent budget: the next request waits the real time", async () => {
  const s = scripted([{ status: 200, headers: exhausted({ date: githubDate }) }, { status: 200 }]);
  const c = client(s, { now: () => AHEAD });
  await c.getJson("/a");
  await c.getJson("/b");
  assert.deepEqual(s.events.map((e) => e.split(" ")[0]), ["fetch", "sleep", "fetch"]);
  assert.deepEqual(s.sleeps, [31_000]);
});

test("clock behind, with the Date header: it does not wait ten minutes too long", async () => {
  const s = scripted([{ status: 200, headers: exhausted({ date: githubDate }) }, { status: 200 }]);
  const c = client(s, { now: () => BEHIND });
  await c.getJson("/a");
  await c.getJson("/b");
  assert.deepEqual(s.sleeps, [31_000]);
});

test("an exhausted 403 with a correct clock waits exactly until the reset, and not the floor", async () => {
  const s = scripted([{ status: 403, headers: exhausted() }, { status: 200 }]);
  await client(s).getJson("/a");
  assert.deepEqual(s.sleeps, [31_000]);
});

test("the floor applies only after a real exhausted response: a window that already rolled over costs no wait", async () => {
  // A 200 says the budget is spent, but by the local clock the reset is long past: nothing is blocking.
  const s = scripted([{ status: 200, headers: exhausted() }, { status: 200 }]);
  const c = client(s, { now: () => AHEAD });
  await c.getJson("/a");
  await c.getJson("/b");
  assert.deepEqual(s.sleeps, []);
});

test("an unreadable Retry-After falls back to the floor instead of retrying at once", async () => {
  for (const bad of ["soon", "", "-5", "1.5"]) {
    const s = scripted([{ status: 429, headers: { "retry-after": bad } }, { status: 200 }]);
    await client(s).getJson("/a");
    assert.deepEqual(s.sleeps, [60_000], JSON.stringify(bad));
  }
});

test("the retry limits are not weakened: a numeric Retry-After still counts toward the same bound", async () => {
  const s = scripted(Array.from({ length: 20 }, () => ({ status: 429, headers: { "retry-after": "3" } })));
  await assert.rejects(client(s).getJson("/a"), (err: GitHubError) => err.status === 429);
  assert.equal(s.requests.length, 6);
  assert.deepEqual(s.sleeps, [3000, 3000, 3000, 3000, 3000]);
});
