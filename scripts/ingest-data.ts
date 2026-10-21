// GitHub ingestion (P2-06): mapping from GitHub JSON to the existing tables, the SQL,
// and the runner. The database, the GitHub client and the changed-files spool are all
// injected, so everything here is tested without a network or a database.

import { GitHubError, type GitHubApi } from "./github-client";

export const DEFAULT_REPOS = ["pallets/flask", "expressjs/express", "pallets/click"] as const;
const PAGE_SIZE = 100;
// Authenticated REST budget per hour, used only for the dry-run estimate.
export const REQUESTS_PER_HOUR = 5000;

// ---- command line ----

const SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepoSlug(value: string): string {
  if (!SLUG_PATTERN.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid repository "${value}"; expected owner/name.`);
  }
  return value;
}

export type IngestArgs = { apply: boolean; limit?: number; repos: string[] };

// Dry run is the default; writing needs --apply. --limit=N caps commits, issues and pull
// requests per repository (newest commits, oldest issues/PRs), for a small first trial.
export function parseIngestArgs(argv: readonly string[]): IngestArgs {
  let apply = false;
  let limit: number | undefined;
  const repos: string[] = [];
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      if (!/^[1-9]\d{0,6}$/.test(value)) throw new Error("--limit must be a positive whole number.");
      limit = Number(value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}. Supported: --apply, --limit=N, owner/name.`);
    else if (!repos.includes(arg)) repos.push(parseRepoSlug(arg));
  }
  return { apply, limit, repos: repos.length > 0 ? repos : [...DEFAULT_REPOS] };
}

export function readGitHubToken(env: Record<string, string | undefined>, required: boolean): string | undefined {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    if (required) throw new Error("GITHUB_TOKEN is not set.");
    return undefined;
  }
  if (/\s/.test(token)) throw new Error("GITHUB_TOKEN contains whitespace.");
  return token;
}

// ---- GitHub payload shapes (only the fields that are used) ----

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// Postgres rejects NUL bytes in text columns, and GitHub text can contain them.
export const stripNul = (value: string): string => value.replaceAll("\u0000", "");
const text = (value: unknown): string | null => {
  const s = str(value);
  return s === null ? null : stripNul(s);
};

const EMAIL_PLACEHOLDER = "[email redacted]";
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;

// Length of the longest prefix of `run` (letters, digits, dots, hyphens) that is a domain:
// dot-separated non-empty labels ending in an alphabetic top-level label of 2+ letters.
// What follows that top-level label (a hyphen, a digit, a dot) is not part of the address.
// Linear time: the only repeated check is precomputed once per run.
function validDomainLength(run: string): number {
  if (run.length === 0 || run[0] === ".") return 0;
  const doubleDot = run.indexOf("..");
  for (let dot = run.lastIndexOf("."); dot > 0; dot = run.lastIndexOf(".", dot - 1)) {
    if (doubleDot !== -1 && doubleDot + 1 <= dot) continue; // an empty label lies before this dot
    let end = dot + 1;
    while (end < run.length && /[A-Za-z]/.test(run[end])) end += 1;
    if (end - (dot + 1) >= 2) return end;
  }
  return 0;
}

// Replaces email addresses with a placeholder and leaves everything else (trailer names,
// angle brackets, punctuation) exactly as it was. It scans outward from each "@" instead of
// using one regex, so a long text with no "@" costs a single pass. @mentions, versions and
// "user@host" without a top-level domain are not emails and are kept; an SSH remote such as
// git@github.com is a known false positive and is redacted.
export function redactEmails(value: string): string {
  if (!value.includes("@")) return value;
  let out = "";
  let last = 0;
  let at = value.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > last && LOCAL_CHAR.test(value[start - 1])) start -= 1;
    let runEnd = at + 1;
    while (runEnd < value.length && DOMAIN_CHAR.test(value[runEnd])) runEnd += 1;
    const domainLength = start < at ? validDomainLength(value.slice(at + 1, runEnd)) : 0;
    if (domainLength > 0) {
      const end = at + 1 + domainLength;
      out += value.slice(last, start) + EMAIL_PLACEHOLDER;
      last = end;
      at = value.indexOf("@", end);
    } else {
      at = value.indexOf("@", at + 1);
    }
  }
  return out + value.slice(last);
}

// Free text from GitHub that is stored: NUL bytes removed, email addresses redacted.
const content = (value: unknown): string | null => {
  const t = text(value);
  return t === null ? null : redactEmails(t);
};

// GitHub logins are short and plain (optionally "[bot]"); anything else is dropped.
const safeLogin = (user: unknown): string | null => {
  const login = loginOf(user);
  return login !== null && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login) ? login : null;
};

const loginOf = (user: unknown): string | null => (isRecord(user) ? str(user.login) : null);

export type UserIds = Map<string, string>;

// GitHub logins are case-insensitive. Unknown logins (or none) mean "no account": NULL.
export function authorIdFor(login: string | null, userIds: UserIds): string | null {
  return login ? (userIds.get(login.toLowerCase()) ?? null) : null;
}

const laterOf = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

// ---- mapping ----

export type RepositoryRow = { projectName: string; description: string | null; name: string; githubUrl: string; defaultBranch: string };

export function mapRepository(meta: unknown): RepositoryRow {
  if (!isRecord(meta)) throw new Error("Unexpected repository response.");
  const fullName = str(meta.full_name);
  const name = str(meta.name);
  const htmlUrl = str(meta.html_url);
  if (!fullName || !name || !htmlUrl) throw new Error("Repository response is missing name or URL.");
  return {
    projectName: fullName,
    description: content(meta.description),
    name,
    githubUrl: htmlUrl,
    defaultBranch: str(meta.default_branch) || "main",
  };
}

export type ChangedFile = { filename: string; status: string; additions: number; deletions: number; changes: number; previous_filename: string | null };

export function mapFiles(files: unknown[]): ChangedFile[] {
  return files.filter(isRecord).map((f) => ({
    filename: str(f.filename) ?? "",
    status: str(f.status) ?? "modified",
    additions: count(f.additions),
    deletions: count(f.deletions),
    changes: count(f.changes),
    previous_filename: str(f.previous_filename),
  }));
}

export type CommitRow = {
  sha: string;
  authorId: string | null;
  authorLogin: string | null; // written to the spool only, never to PostgreSQL
  message: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  committedAt: string;
};

// Returns null when the commit cannot satisfy the table (bad sha or no date).
export function mapCommit(detail: unknown, files: ChangedFile[], userIds: UserIds): CommitRow | null {
  if (!isRecord(detail) || !isRecord(detail.commit)) return null;
  const sha = str(detail.sha)?.toLowerCase();
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const author = isRecord(detail.commit.author) ? detail.commit.author : {}; // only its date is used
  const committer = isRecord(detail.commit.committer) ? detail.commit.committer : {};
  const committedAt = str(committer.date) ?? str(author.date);
  if (!committedAt || Number.isNaN(Date.parse(committedAt))) return null;
  const stats = isRecord(detail.stats) ? detail.stats : {};
  return {
    sha,
    authorId: authorIdFor(loginOf(detail.author), userIds),
    authorLogin: safeLogin(detail.author),
    message: content(detail.commit.message) ?? "",
    additions: stats.additions !== undefined ? count(stats.additions) : files.reduce((sum, f) => sum + f.additions, 0),
    deletions: stats.deletions !== undefined ? count(stats.deletions) : files.reduce((sum, f) => sum + f.deletions, 0),
    filesChanged: files.length,
    committedAt,
  };
}

export type IssueRow = {
  number: number;
  title: string;
  body: string | null;
  status: "open" | "closed";
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

// Satisfies the table checks: closed <=> closed_at, and updated/closed never before created.
export function mapIssue(item: unknown, userIds: UserIds): IssueRow | null {
  if (!isRecord(item) || typeof item.number !== "number") return null;
  const createdAt = str(item.created_at);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  const updatedAt = laterOf(str(item.updated_at) ?? createdAt, createdAt);
  const closed = item.state === "closed";
  return {
    number: item.number,
    title: content(item.title) ?? "",
    body: content(item.body),
    status: closed ? "closed" : "open",
    authorId: authorIdFor(loginOf(item.user), userIds),
    createdAt,
    updatedAt,
    closedAt: closed ? laterOf(str(item.closed_at) ?? updatedAt, createdAt) : null,
  };
}

export type PullRow = {
  number: number;
  title: string;
  description: string | null;
  status: "open" | "closed" | "merged";
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
};

// merged <=> merged_at. 'approved' is never produced (it would come from reviews) and
// merged_by stays NULL: the list endpoint does not include it.
export function mapPull(item: unknown, userIds: UserIds): PullRow | null {
  if (!isRecord(item) || typeof item.number !== "number") return null;
  const createdAt = str(item.created_at);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  const updatedAt = laterOf(str(item.updated_at) ?? createdAt, createdAt);
  const mergedRaw = str(item.merged_at);
  const merged = mergedRaw !== null && !Number.isNaN(Date.parse(mergedRaw));
  return {
    number: item.number,
    title: content(item.title) ?? "",
    description: content(item.body),
    status: merged ? "merged" : item.state === "closed" ? "closed" : "open",
    authorId: authorIdFor(loginOf(item.user), userIds),
    createdAt,
    updatedAt: merged ? laterOf(updatedAt, mergedRaw) : updatedAt,
    mergedAt: merged ? laterOf(mergedRaw, createdAt) : null,
  };
}

// ---- SQL: parameterized, explicit conflict targets, never destructive ----

export const UPSERT_PROJECT_SQL =
  "INSERT INTO projects (name, description, status) VALUES ($1::text, $2::text, $3::text) ON CONFLICT (name) DO NOTHING";
export const SELECT_PROJECT_ID_SQL = "SELECT id FROM projects WHERE name = $1::text";
export const UPSERT_REPOSITORY_SQL =
  "INSERT INTO repositories (project_id, name, github_url, default_branch, is_synthetic) " +
  "VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::boolean) " +
  "ON CONFLICT (github_url) DO UPDATE SET default_branch = EXCLUDED.default_branch RETURNING id";
export const SELECT_USERS_SQL = "SELECT id, github_username FROM users WHERE github_username IS NOT NULL";
export const SELECT_KNOWN_SHAS_SQL = "SELECT sha FROM commits WHERE repository_id = $1::bigint";
export const INSERT_COMMIT_SQL =
  "INSERT INTO commits (repository_id, sha, author_id, message, additions, deletions, files_changed, committed_at) " +
  "VALUES ($1::bigint, $2::text, $3::bigint, $4::text, $5::int, $6::int, $7::int, $8::timestamptz) " +
  "ON CONFLICT (repository_id, sha) DO NOTHING";
// Issues and PRs change upstream, so they are upserted, but only when GitHub's copy is
// newer: a later local edit (which bumps updated_at) is not overwritten by a re-run.
export const UPSERT_ISSUE_SQL =
  "INSERT INTO issues (repository_id, number, title, body, status, author_id, created_at, updated_at, closed_at) " +
  "VALUES ($1::bigint, $2::int, $3::text, $4::text, $5::text, $6::bigint, $7::timestamptz, $8::timestamptz, $9::timestamptz) " +
  "ON CONFLICT (repository_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status, " +
  "author_id = EXCLUDED.author_id, updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at " +
  "WHERE issues.updated_at < EXCLUDED.updated_at";
export const UPSERT_PULL_SQL =
  "INSERT INTO pull_requests (repository_id, number, title, description, status, author_id, created_at, updated_at, merged_at) " +
  "VALUES ($1::bigint, $2::int, $3::text, $4::text, $5::text, $6::bigint, $7::timestamptz, $8::timestamptz, $9::timestamptz) " +
  "ON CONFLICT (repository_id, number) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status, " +
  "author_id = EXCLUDED.author_id, updated_at = EXCLUDED.updated_at, merged_at = EXCLUDED.merged_at " +
  "WHERE pull_requests.updated_at < EXCLUDED.updated_at";

// ---- injected interfaces ----

export type IngestDb = {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export type SpoolLine = { repo: string; sha: string; committed_at: string; author_login: string | null; files: ChangedFile[] };
// Changed-file details have no table in the schema; they go to a local JSON Lines file
// for the later MongoDB load (P2-09/P2-10).
export type Spool = {
  has(repo: string, sha: string): Promise<boolean>;
  append(repo: string, lines: SpoolLine[]): Promise<void>;
};

export type IngestDeps = { github: GitHubApi; db: IngestDb; spool: Spool; userIds: UserIds; log: (line: string) => void };

async function inTransaction<T>(db: IngestDb, work: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw err;
  }
}

export async function loadUserIds(db: IngestDb): Promise<UserIds> {
  const { rows } = await db.query(SELECT_USERS_SQL);
  const ids: UserIds = new Map();
  for (const row of rows) ids.set(String(row.github_username).toLowerCase(), String(row.id));
  return ids;
}

// ---- running one repository ----

export type RepoSummary = {
  repo: string;
  commits: { listed: number; fetched: number; inserted: number; alreadyStored: number; invalid: number };
  issues: { listed: number; upserted: number; unchanged: number };
  pulls: { listed: number; upserted: number; unchanged: number };
};

async function fetchCommitDetail(github: GitHubApi, slug: string, sha: string) {
  const first = await github.getJson(`/repos/${slug}/commits/${sha}?per_page=300`);
  const files: unknown[] = isRecord(first.data) && Array.isArray(first.data.files) ? [...first.data.files] : [];
  // Commits with more than 300 files continue on further pages (GitHub stops at 3000).
  let next = first.link.next;
  while (next) {
    const page = await github.getJson(next);
    if (isRecord(page.data) && Array.isArray(page.data.files)) files.push(...page.data.files);
    next = page.link.next;
  }
  return { detail: first.data, files: mapFiles(files) };
}

async function ingestCommits(deps: IngestDeps, slug: string, repoId: string, limit: number | undefined, summary: RepoSummary) {
  const { github, db, spool, userIds, log } = deps;
  const known = new Set((await db.query(SELECT_KNOWN_SHAS_SQL, [repoId])).rows.map((row) => String(row.sha)));
  let seen = 0;

  try {
    for await (const page of github.paginate(`/repos/${slug}/commits?per_page=${PAGE_SIZE}`)) {
      const pending: CommitRow[] = [];
      const spoolLines: SpoolLine[] = [];

      // Saves what this page has fetched so far; used on success and before rethrowing.
      const flush = async () => {
        if (pending.length === 0) return;
        if (spoolLines.length > 0) await spool.append(slug, spoolLines.splice(0));
        const inserted = await inTransaction(db, async () => {
          let n = 0;
          for (const r of pending) {
            const res = await db.query(INSERT_COMMIT_SQL, [repoId, r.sha, r.authorId, r.message, r.additions, r.deletions, r.filesChanged, r.committedAt]);
            if (res.rowCount === 1) n += 1;
          }
          return n;
        });
        summary.commits.inserted += inserted;
        summary.commits.alreadyStored += pending.length - inserted;
        for (const r of pending) known.add(r.sha);
        pending.length = 0;
      };

      try {
        for (const item of page) {
          if (limit !== undefined && seen >= limit) break;
          seen += 1;
          summary.commits.listed += 1;
          const sha = isRecord(item) && typeof item.sha === "string" ? item.sha.toLowerCase() : "";
          if (!/^[0-9a-f]{7,40}$/.test(sha)) {
            summary.commits.invalid += 1; // never build a request path from an unexpected value
            continue;
          }
          if (known.has(sha)) {
            summary.commits.alreadyStored += 1;
            continue;
          }
          const { detail, files } = await fetchCommitDetail(github, slug, sha);
          summary.commits.fetched += 1;
          const row = mapCommit(detail, files, userIds);
          if (!row) {
            summary.commits.invalid += 1;
            continue;
          }
          pending.push(row);
          if (!(await spool.has(slug, row.sha))) spoolLines.push({ repo: slug, sha: row.sha, committed_at: row.committedAt, author_login: row.authorLogin, files });
        }
      } catch (err) {
        await flush().catch(() => {}); // keep the progress; the original error is what matters
        throw err;
      }
      await flush();
      log(`${slug}: commits listed ${summary.commits.listed}, inserted ${summary.commits.inserted}`);
      if (limit !== undefined && seen >= limit) break;
    }
  } catch (err) {
    // An empty repository answers 409 to the commit list; that is just "no commits".
    if (err instanceof GitHubError && err.status === 409 && summary.commits.listed === 0) return;
    throw err;
  }
}

async function ingestUpserts<Row>(opts: {
  deps: IngestDeps;
  path: string;
  repoId: string;
  limit: number | undefined;
  keep: (item: unknown) => boolean;
  map: (item: unknown) => Row | null;
  sql: string;
  params: (repoId: string, row: Row) => unknown[];
  tally: { listed: number; upserted: number; unchanged: number };
  label: string;
  slug: string;
}) {
  const { deps, tally } = opts;
  for await (const page of deps.github.paginate(opts.path)) {
    const rows: Row[] = [];
    for (const item of page) {
      if (!opts.keep(item)) continue;
      if (opts.limit !== undefined && tally.listed >= opts.limit) break;
      tally.listed += 1;
      const row = opts.map(item);
      if (row) rows.push(row);
    }
    const changed = await inTransaction(deps.db, async () => {
      let n = 0;
      for (const row of rows) if ((await deps.db.query(opts.sql, opts.params(opts.repoId, row))).rowCount === 1) n += 1;
      return n;
    });
    tally.upserted += changed;
    tally.unchanged += rows.length - changed;
    deps.log(`${opts.slug}: ${opts.label} listed ${tally.listed}, upserted ${tally.upserted}`);
    if (opts.limit !== undefined && tally.listed >= opts.limit) break;
  }
}

export async function ingestRepository(deps: IngestDeps, slug: string, limit?: number): Promise<RepoSummary> {
  const { github, db } = deps;
  const repo = mapRepository((await github.getJson(`/repos/${slug}`)).data);

  const repoId = await inTransaction(db, async () => {
    await db.query(UPSERT_PROJECT_SQL, [repo.projectName, repo.description, "active"]);
    const project = (await db.query(SELECT_PROJECT_ID_SQL, [repo.projectName])).rows[0];
    const saved = (await db.query(UPSERT_REPOSITORY_SQL, [project.id, repo.name, repo.githubUrl, repo.defaultBranch, false])).rows[0];
    return String(saved.id);
  });

  const summary: RepoSummary = {
    repo: slug,
    commits: { listed: 0, fetched: 0, inserted: 0, alreadyStored: 0, invalid: 0 },
    issues: { listed: 0, upserted: 0, unchanged: 0 },
    pulls: { listed: 0, upserted: 0, unchanged: 0 },
  };

  await ingestCommits(deps, slug, repoId, limit, summary);

  await ingestUpserts<IssueRow>({
    deps, slug, repoId, limit, label: "issues", tally: summary.issues,
    path: `/repos/${slug}/issues?state=all&per_page=${PAGE_SIZE}&sort=created&direction=asc`,
    keep: (item) => isRecord(item) && !("pull_request" in item), // the issues list also returns PRs
    map: (item) => mapIssue(item, deps.userIds),
    sql: UPSERT_ISSUE_SQL,
    params: (id, r) => [id, r.number, r.title, r.body, r.status, r.authorId, r.createdAt, r.updatedAt, r.closedAt],
  });

  await ingestUpserts<PullRow>({
    deps, slug, repoId, limit, label: "pull requests", tally: summary.pulls,
    path: `/repos/${slug}/pulls?state=all&per_page=${PAGE_SIZE}&sort=created&direction=asc`,
    keep: isRecord,
    map: (item) => mapPull(item, deps.userIds),
    sql: UPSERT_PULL_SQL,
    params: (id, r) => [id, r.number, r.title, r.description, r.status, r.authorId, r.createdAt, r.updatedAt, r.mergedAt],
  });

  return summary;
}

// ---- dry run: sizes and request estimate, no database and no writes ----

export type RepoPlan = {
  repo: string;
  defaultBranch: string;
  archived: boolean;
  commits: number;
  pulls: number;
  issues: number;
  requests: { metadata: number; commitPages: number; commitDetails: number; pullPages: number; issuePages: number; total: number };
};

const lastPage = (link: Record<string, string>): number | undefined => {
  const match = link.last?.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : undefined;
};

async function countItems(github: GitHubApi, path: string): Promise<number> {
  const { data, link } = await github.getJson(`${path}${path.includes("?") ? "&" : "?"}per_page=1`);
  return lastPage(link) ?? (Array.isArray(data) ? data.length : 0);
}

export function estimateRequests(sizes: { commits: number; pulls: number; maxNumber: number }, limit?: number) {
  const commits = limit === undefined ? sizes.commits : Math.min(limit, sizes.commits);
  const pulls = limit === undefined ? sizes.pulls : Math.min(limit, sizes.pulls);
  // The issues list returns issues and PRs together, so it spans every number.
  const listed = limit === undefined ? sizes.maxNumber : Math.min(limit * 2, sizes.maxNumber);
  const requests = {
    metadata: 1,
    commitPages: Math.ceil(commits / PAGE_SIZE),
    commitDetails: commits,
    pullPages: Math.ceil(pulls / PAGE_SIZE),
    issuePages: Math.ceil(listed / PAGE_SIZE),
    total: 0,
  };
  requests.total = requests.metadata + requests.commitPages + requests.commitDetails + requests.pullPages + requests.issuePages;
  return requests;
}

export async function planRepository(github: GitHubApi, slug: string, limit?: number): Promise<RepoPlan> {
  const metaRaw = (await github.getJson(`/repos/${slug}`)).data;
  const repo = mapRepository(metaRaw);
  const commits = await countItems(github, `/repos/${slug}/commits`);
  const pulls = await countItems(github, `/repos/${slug}/pulls?state=all`);
  const newest = (await github.getJson(`/repos/${slug}/issues?state=all&per_page=1&sort=created&direction=desc`)).data;
  const maxNumber = Array.isArray(newest) && isRecord(newest[0]) && typeof newest[0].number === "number" ? newest[0].number : 0;
  return {
    repo: slug,
    defaultBranch: repo.defaultBranch,
    archived: isRecord(metaRaw) && metaRaw.archived === true,
    commits,
    pulls,
    issues: Math.max(0, maxNumber - pulls),
    requests: estimateRequests({ commits, pulls, maxNumber }, limit),
  };
}
