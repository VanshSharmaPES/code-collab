import "server-only";
import { query } from "@/lib/db";
import type { IssueInput, IssuePriority, IssueStatus } from "@/lib/issue-input";
import { participantSql } from "@/lib/project-access";

export const PAGE_SIZE = 25;

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// Names only: the users table's email and password_hash are never selected here.
const ISSUE_COLUMNS =
  "i.id::text AS id, i.number, i.title, i.body, i.status, i.priority, i.created_at, i.updated_at, i.closed_at, " +
  "i.repository_id::text AS repository_id, r.name AS repository_name, p.name AS project_name, " +
  "a.full_name AS author_name, s.full_name AS assignee_name, (r.github_url IS NOT NULL) AS is_mirrored";
const ISSUE_FROM =
  "FROM issues i JOIN repositories r ON r.id = i.repository_id JOIN projects p ON p.id = r.project_id " +
  "LEFT JOIN users a ON a.id = i.author_id LEFT JOIN users s ON s.id = i.assignee_id";

// Optional filters are bound parameters: a NULL means "no filter". The last parameter is the viewer (the signed-in
// user); only issues of projects the viewer takes part in are ever returned (see project-access.ts).
export const LIST_ISSUES_SQL =
  `SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} ` +
  "WHERE ($1::bigint IS NULL OR i.repository_id = $1::bigint) AND ($2::text IS NULL OR i.status = $2::text) " +
  `AND ${participantSql("$5", "r.project_id")} ` +
  "ORDER BY i.updated_at DESC, i.id DESC LIMIT $3 OFFSET $4";
export const COUNT_ISSUES_SQL =
  "SELECT count(*)::int AS n FROM issues i JOIN repositories r ON r.id = i.repository_id " +
  "WHERE ($1::bigint IS NULL OR i.repository_id = $1::bigint) AND ($2::text IS NULL OR i.status = $2::text) " +
  `AND ${participantSql("$3", "r.project_id")}`;
export const GET_ISSUE_SQL = `SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} WHERE i.id = $1::bigint AND ${participantSql("$2", "r.project_id")}`;
// Repositories of the viewer's projects: used for the filter on the issue list, where mirrored issues are shown.
export const LIST_REPOSITORIES_SQL =
  "SELECT r.id::text AS id, r.name, p.name AS project_name FROM repositories r JOIN projects p ON p.id = r.project_id " +
  `WHERE ${participantSql("$1", "r.project_id")} ORDER BY p.name, r.name`;
// Only repositories that accept new issues: a repository with a github_url mirrors GitHub and is read-only here.
export const LIST_WRITABLE_REPOSITORIES_SQL =
  "SELECT r.id::text AS id, r.name, p.name AS project_name FROM repositories r JOIN projects p ON p.id = r.project_id " +
  `WHERE r.github_url IS NULL AND ${participantSql("$1", "r.project_id")} ORDER BY p.name, r.name`;

// The next number is max + 1 within the repository, in one statement. Two writers can still pick the same
// number; the UNIQUE (repository_id, number) constraint then rejects one and createIssue retries.
// HAVING EXISTS makes the INSERT produce no row unless the repository exists and has no github_url (it is not
// a GitHub mirror). The final SELECT always returns one row: the new id (NULL when nothing was inserted) and
// whether the repository is a mirror (NULL when it does not exist), so the caller can tell the cases apart.
export const CREATE_ISSUE_SQL =
  "WITH ins AS (" +
  "INSERT INTO issues (repository_id, number, title, body, status, priority, author_id, closed_at) " +
  "SELECT $1::bigint, COALESCE(MAX(number), 0) + 1, $2::text, $3::text, $4::text, $5::text, $6::bigint, " +
  "CASE WHEN $4::text = 'closed' THEN now() END FROM issues WHERE repository_id = $1::bigint " +
  `HAVING EXISTS (SELECT 1 FROM repositories WHERE id = $1::bigint AND github_url IS NULL AND ${participantSql("$6", "repositories.project_id")}) ` +
  "RETURNING id) " +
  "SELECT (SELECT id::text FROM ins) AS id, " +
  `(SELECT github_url IS NOT NULL FROM repositories WHERE id = $1::bigint AND ${participantSql("$6", "repositories.project_id")}) AS mirrored`;
// updated_at moves forward, so a later ingestion (which only overwrites older rows) keeps this edit.
// set_config(..., true) sets codecollab.actor_id for this transaction only, in the same statement, so the audit trigger
// records who made the edit. Issues in a GitHub mirror (github_url set) are never updated; the final SELECT reports
// whether the issue's repository is a mirror (false for a missing issue), so the caller can tell the cases apart.
export const UPDATE_ISSUE_SQL =
  "WITH upd AS (" +
  "UPDATE issues i SET title = $2::text, body = $3::text, status = $4::text, priority = $5::text, updated_at = now(), " +
  "closed_at = CASE WHEN $4::text = 'closed' THEN COALESCE(i.closed_at, now()) ELSE NULL END " +
  "FROM (SELECT set_config('codecollab.actor_id', $6::text, true)) AS actor " +
  `WHERE i.id = $1::bigint AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = i.repository_id AND r.github_url IS NULL AND ${participantSql("$6", "r.project_id")}) ` +
  "RETURNING i.id) " +
  "SELECT (SELECT id::text FROM upd) AS id, " +
  `EXISTS (SELECT 1 FROM issues x JOIN repositories r ON r.id = x.repository_id WHERE x.id = $1::bigint AND r.github_url IS NOT NULL AND ${participantSql("$6", "r.project_id")}) AS mirrored`;

export type IssueRow = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  created_at: Date | string;
  updated_at: Date | string;
  closed_at: Date | string | null;
  repository_id: string;
  repository_name: string;
  project_name: string;
  author_name: string | null;
  assignee_name: string | null;
  is_mirrored: boolean; // the repository mirrors GitHub (has a github_url), so the issue is read-only here
};
export type RepositoryOption = { id: string; name: string; project_name: string };

export type IssueFilters = { repositoryId: string | null; status: string | null };

export async function listIssues(
  filters: IssueFilters,
  page: number,
  viewerId: string,
  run: RunQuery<IssueRow> = query<IssueRow>,
): Promise<IssueRow[]> {
  return run(LIST_ISSUES_SQL, [filters.repositoryId, filters.status, PAGE_SIZE, (page - 1) * PAGE_SIZE, viewerId]);
}

export async function countIssues(filters: IssueFilters, viewerId: string, run: RunQuery<{ n: number }> = query<{ n: number }>): Promise<number> {
  return (await run(COUNT_ISSUES_SQL, [filters.repositoryId, filters.status, viewerId]))[0]?.n ?? 0;
}

// Null when there is no such issue or the viewer does not take part in its project (the page shows a 404 for both).
export async function getIssue(id: string, viewerId: string, run: RunQuery<IssueRow> = query<IssueRow>): Promise<IssueRow | null> {
  return (await run(GET_ISSUE_SQL, [id, viewerId]))[0] ?? null;
}

export async function listRepositories(viewerId: string, run: RunQuery<RepositoryOption> = query<RepositoryOption>): Promise<RepositoryOption[]> {
  return run(LIST_REPOSITORIES_SQL, [viewerId]);
}

export async function listWritableRepositories(viewerId: string, run: RunQuery<RepositoryOption> = query<RepositoryOption>): Promise<RepositoryOption[]> {
  return run(LIST_WRITABLE_REPOSITORIES_SQL, [viewerId]);
}

export class RepositoryNotFoundError extends Error {}
export const MIRRORED_READ_ONLY_MESSAGE = "GitHub-mirrored issues are read-only.";
export class MirroredIssueError extends Error {
  constructor() {
    super(MIRRORED_READ_ONLY_MESSAGE);
  }
}

// Issues in a GitHub mirror cannot be edited here; the SQL enforces it, this only decides what the page shows.
export function canEditIssue(issue: Pick<IssueRow, "is_mirrored">): boolean {
  return !issue.is_mirrored;
}

type WriteRow = { id: string | null; mirrored?: boolean | null };

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const ISSUES_REPOSITORY_FKEY = "issues_repository_id_fkey"; // other foreign keys (author_id) must not read as a missing repository
const MAX_NUMBER_ATTEMPTS = 5;

export async function createIssue(
  repositoryId: string,
  input: IssueInput,
  authorId: string,
  run: RunQuery<WriteRow> = query<WriteRow>,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await run(CREATE_ISSUE_SQL, [repositoryId, input.title, input.body, input.status, input.priority, authorId]);
      const row = rows[0];
      if (rows.length === 1 && row.id) return row.id;
      if (row?.mirrored === true) throw new MirroredIssueError(); // nothing was inserted: the repository mirrors GitHub
      throw new RepositoryNotFoundError(); // nothing was inserted: no such repository
    } catch (err) {
      const { code, constraint } = err as { code?: string; constraint?: string };
      if (code === PG_FOREIGN_KEY_VIOLATION && constraint === ISSUES_REPOSITORY_FKEY) throw new RepositoryNotFoundError();
      if (code === PG_UNIQUE_VIOLATION && attempt < MAX_NUMBER_ATTEMPTS) continue;
      throw err;
    }
  }
}

// Returns false when the issue does not exist; throws MirroredIssueError when it belongs to a GitHub mirror.
export async function updateIssue(
  id: string,
  input: IssueInput,
  actorId: string,
  run: RunQuery<WriteRow> = query<WriteRow>,
): Promise<boolean> {
  const row = (await run(UPDATE_ISSUE_SQL, [id, input.title, input.body, input.status, input.priority, actorId]))[0];
  if (row?.id) return true;
  if (row?.mirrored === true) throw new MirroredIssueError();
  return false;
}
