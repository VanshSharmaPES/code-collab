// Minimal GitHub REST client for the ingestion script (P2-06): pagination, rate-limit
// waits, retries. fetch and sleep are injectable so tests need no network or real time.
//
// Token safety: every URL is checked to be on https://api.github.com before a request is
// made, redirects are followed manually (same host only), and error messages carry only
// the status and the URL path, never headers, query strings or the token.

export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

type ResponseLike = Pick<Response, "status" | "headers" | "text">;
export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export type GitHubClientOptions = {
  token?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxRateLimitWaits?: number;
  log?: (line: string) => void;
};

export type GitHubResult = { data: unknown; link: Record<string, string> };

// What the ingestion code needs from the client; tests can fake it.
export interface GitHubApi {
  getJson(path: string): Promise<GitHubResult>;
  paginate(path: string): AsyncGenerator<unknown[]>;
  readonly requestCount: number;
}

// Parses `<url>; rel="next", <url>; rel="last"` into { next: url, last: url }.
export function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

const REDIRECTS = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
// Stop one request early rather than spend the very last unit of the budget.
const RATE_LIMIT_RESERVE = 1;
// When GitHub reports an exhausted limit but our clock says the reset has already passed
// (or Retry-After is unreadable), the estimate is wrong. Wait this long instead of retrying
// at once. It is only used after a real exhausted response, never as a general delay.
const EXHAUSTED_MIN_WAIT_MS = 60_000;

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubApi {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxRateLimitWaits = options.maxRateLimitWaits ?? 5;
  const log = options.log ?? (() => {});

  let remaining: number | undefined;
  let resetAtMs: number | undefined;
  let clockOffsetMs = 0; // GitHub's clock minus ours, from the last Date header
  let requestCount = 0;

  // The reset time is on GitHub's clock, so compare it with GitHub's idea of "now".
  const githubNow = () => now() + clockOffsetMs;

  // Only api.github.com over https: this is what keeps the token from being sent elsewhere.
  function resolveUrl(urlOrPath: string): string {
    const url = urlOrPath.startsWith("/") ? GITHUB_API + urlOrPath : urlOrPath;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GitHubError("Refusing to request an invalid URL.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com" || parsed.username || parsed.password) {
      throw new GitHubError("Refusing to request a URL outside https://api.github.com.");
    }
    return parsed.toString();
  }

  function safePath(url: string): string {
    return new URL(url).pathname;
  }

  function noteRateLimit(headers: Headers) {
    const date = headers.get("date");
    if (date !== null && !Number.isNaN(Date.parse(date))) clockOffsetMs = Date.parse(date) - now();
    const left = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (left !== null && /^\d+$/.test(left)) remaining = Number(left);
    if (reset !== null && /^\d+$/.test(reset)) resetAtMs = Number(reset) * 1000;
  }

  // Waits for the window to reset when the budget is (nearly) spent.
  async function waitForBudget() {
    if (remaining !== undefined && remaining <= RATE_LIMIT_RESERVE && resetAtMs !== undefined) {
      const waitMs = resetAtMs - githubNow() + 1000;
      if (waitMs > 0) {
        log(`Rate limit nearly spent; waiting ${Math.ceil(waitMs / 1000)}s for the window to reset.`);
        await sleep(waitMs);
      }
      remaining = undefined;
    }
  }

  const backoff = (attempt: number) => baseDelayMs * 2 ** (attempt - 1) * (0.5 + random() / 2);

  async function request(urlOrPath: string): Promise<GitHubResult> {
    let url = resolveUrl(urlOrPath);
    let retries = 0;
    let limitWaits = 0;
    let redirects = 0;

    for (;;) {
      await waitForBudget();
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codecollab-ingest",
      };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;

      let res: ResponseLike;
      try {
        requestCount += 1;
        res = await doFetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        if (retries >= maxRetries) throw new GitHubError(`GitHub request failed (network error) for ${safePath(url)}.`);
        retries += 1;
        await sleep(backoff(retries));
        continue;
      }
      noteRateLimit(res.headers);

      if (REDIRECTS.has(res.status)) {
        const location = res.headers.get("location");
        if (!location || ++redirects > MAX_REDIRECTS) throw new GitHubError(`Too many or invalid redirects for ${safePath(url)}.`, res.status);
        url = resolveUrl(new URL(location, url).toString());
        continue;
      }

      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
        if (retryAfter !== null || exhausted) {
          if (++limitWaits > maxRateLimitWaits) throw new GitHubError(`GitHub rate limit still exceeded for ${safePath(url)}.`, res.status);
          if (retryAfter !== null) {
            // Retry-After is a number of seconds; anything else is unreadable, so use the floor.
            const waitMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : EXHAUSTED_MIN_WAIT_MS;
            log(`GitHub asked to slow down; waiting ${Math.ceil(waitMs / 1000)}s.`);
            await sleep(waitMs);
          } else {
            // Primary limit: wait until GitHub's reset. If our estimate says that moment has
            // passed even though GitHub just refused us, the estimate is wrong, so use the floor.
            const untilReset = resetAtMs === undefined ? 0 : resetAtMs - githubNow() + 1000;
            const waitMs = untilReset > 0 ? untilReset : EXHAUSTED_MIN_WAIT_MS;
            log(`Rate limit exhausted; waiting ${Math.ceil(waitMs / 1000)}s.`);
            await sleep(waitMs);
            remaining = undefined; // already waited; do not wait again at the top of the loop
          }
          continue;
        }
      }

      if (res.status >= 500 || res.status === 408) {
        if (retries >= maxRetries) throw new GitHubError(`GitHub API error ${res.status} for ${safePath(url)}.`, res.status);
        retries += 1;
        await sleep(backoff(retries));
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new GitHubError(`GitHub API error ${res.status} for ${safePath(url)}.`, res.status);
      }

      const text = await res.text();
      let data: unknown = null;
      if (text.trim() !== "") {
        try {
          data = JSON.parse(text);
        } catch {
          throw new GitHubError(`GitHub returned invalid JSON for ${safePath(url)}.`, res.status);
        }
      }
      return { data, link: parseLinkHeader(res.headers.get("link")) };
    }
  }

  return {
    getJson: request,
    async *paginate(path: string) {
      let next: string | undefined = path;
      while (next) {
        const { data, link } = await request(next);
        if (!Array.isArray(data)) throw new GitHubError(`Expected a list from ${safePath(resolveUrl(next))}.`);
        yield data;
        next = link.next;
      }
    },
    get requestCount() {
      return requestCount;
    },
  };
}
