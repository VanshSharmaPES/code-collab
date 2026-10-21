import "server-only";
import { query } from "@/lib/db";
import type { IssueInput, IssuePriority, IssueStatus } from "@/lib/issue-input";

export const PAGE_SIZE = 25;

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// Names only: the users table's email and password_hash are never selected here.
const ISSUE_COLUMNS =
  "i.id::text AS id, i.number, i.title, i.body, i.status, i.priority, i.created_at, i.updated_at, i.closed_at, " +
  "i.repository_id::text AS repository_id, r.name AS repository_name, p.name AS project_name, " +
  "a.full_name AS author_name, s.full_name AS assignee_name";
const ISSUE_FROM =
  "FROM issues i JOIN repositories r ON r.id = i.repository_id JOIN projects p ON p.id = r.project_id " +
  "LEFT JOIN users a ON a.id = i.author_id LEFT JOIN users s ON s.id = i.assignee_id";

// Optional filters are bound parameters: a NULL means "no filter".
export const LIST_ISSUES_SQL =
  `SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} ` +
  "WHERE ($1::bigint IS NULL OR i.repository_id = $1::bigint) AND ($2::text IS NULL OR i.status = $2::text) " +
  "ORDER BY i.updated_at DESC, i.id DESC LIMIT $3 OFFSET $4";
export const COUNT_ISSUES_SQL =
  "SELECT count(*)::int AS n FROM issues i " +
  "WHERE ($1::bigint IS NULL OR i.repository_id = $1::bigint) AND ($2::text IS NULL OR i.status = $2::text)";
export const GET_ISSUE_SQL = `SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} WHERE i.id = $1::bigint`;
export const LIST_REPOSITORIES_SQL =
  "SELECT r.id::text AS id, r.name, p.name AS project_name FROM repositories r JOIN projects p ON p.id = r.project_id ORDER BY p.name, r.name";

// The next number is max + 1 within the repository, in one statement. Two writers can still pick the same
// number; the UNIQUE (repository_id, number) constraint then rejects one and createIssue retries.
export const CREATE_ISSUE_SQL =
  "INSERT INTO issues (repository_id, number, title, body, status, priority, author_id, closed_at) " +
  "SELECT $1::bigint, COALESCE(MAX(number), 0) + 1, $2::text, $3::text, $4::text, $5::text, $6::bigint, " +
  "CASE WHEN $4::text = 'closed' THEN now() END FROM issues WHERE repository_id = $1::bigint " +
  "RETURNING id::text AS id";
// updated_at moves forward, so a later ingestion (which only overwrites older rows) keeps this edit.
export const UPDATE_ISSUE_SQL =
  "UPDATE issues i SET title = $2::text, body = $3::text, status = $4::text, priority = $5::text, updated_at = now(), " +
  "closed_at = CASE WHEN $4::text = 'closed' THEN COALESCE(i.closed_at, now()) ELSE NULL END " +
  "WHERE id = $1::bigint RETURNING i.id::text AS id";

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
};
export type RepositoryOption = { id: string; name: string; project_name: string };

export type IssueFilters = { repositoryId: string | null; status: string | null };

export async function listIssues(
  filters: IssueFilters,
  page: number,
  run: RunQuery<IssueRow> = query<IssueRow>,
): Promise<IssueRow[]> {
  return run(LIST_ISSUES_SQL, [filters.repositoryId, filters.status, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
}

export async function countIssues(filters: IssueFilters, run: RunQuery<{ n: number }> = query<{ n: number }>): Promise<number> {
  return (await run(COUNT_ISSUES_SQL, [filters.repositoryId, filters.status]))[0]?.n ?? 0;
}

export async function getIssue(id: string, run: RunQuery<IssueRow> = query<IssueRow>): Promise<IssueRow | null> {
  return (await run(GET_ISSUE_SQL, [id]))[0] ?? null;
}

export async function listRepositories(run: RunQuery<RepositoryOption> = query<RepositoryOption>): Promise<RepositoryOption[]> {
  return run(LIST_REPOSITORIES_SQL, []);
}

export class RepositoryNotFoundError extends Error {}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const MAX_NUMBER_ATTEMPTS = 5;

export async function createIssue(
  repositoryId: string,
  input: IssueInput,
  authorId: string,
  run: RunQuery<{ id: string }> = query<{ id: string }>,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await run(CREATE_ISSUE_SQL, [repositoryId, input.title, input.body, input.status, input.priority, authorId]);
      if (rows.length === 1) return rows[0].id;
      throw new RepositoryNotFoundError(); // the SELECT produced no row, so nothing was inserted
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === PG_FOREIGN_KEY_VIOLATION) throw new RepositoryNotFoundError();
      if (code === PG_UNIQUE_VIOLATION && attempt < MAX_NUMBER_ATTEMPTS) continue;
      throw err;
    }
  }
}

// Returns false when the issue does not exist.
export async function updateIssue(
  id: string,
  input: IssueInput,
  _actorId: string, // kept so callers need not change; the SQL does not use it
  run: RunQuery<{ id: string }> = query<{ id: string }>,
): Promise<boolean> {
  return (await run(UPDATE_ISSUE_SQL, [id, input.title, input.body, input.status, input.priority])).length === 1;
}
