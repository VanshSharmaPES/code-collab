import "server-only";
import { query } from "@/lib/db";
import { managerSql } from "@/lib/project-access";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

// The four relational analytical queries of P1-13 (db/queries/01..04), shown on the dashboard (P2-13). Each is the P1-13
// query with one addition: only projects the viewer manages (its mentor, or the lead of one of its teams) are included,
// and the viewer ($1) is always the signed-in user. They read the views and functions of P1-11 and P1-12
// (member_contribution_v, contribution_counts), so db/schema/05 and 06 must be applied. The size of the lists is capped.
export const ROW_LIMIT = 50;
export const STALE_DAYS = 14;

// Q1: top three contributors per project by contribution score, with their share of the project total.
export const TOP_CONTRIBUTORS_SQL =
  "SELECT project_id::text AS project_id, project_name, rank::int AS rank, user_id::text AS user_id, full_name, score, " +
  "round(100 * score / nullif(project_total, 0), 1) AS pct_of_project FROM (" +
  "SELECT m.*, RANK() OVER (PARTITION BY m.project_id ORDER BY m.score DESC) AS rank, SUM(m.score) OVER (PARTITION BY m.project_id) AS project_total " +
  `FROM member_contribution_v m WHERE ${managerSql("$1", "m.project_id")}) ranked WHERE rank <= 3 ORDER BY project_id, rank, user_id`;

// Q2: high and critical issues that are still unresolved and have not been touched for more than STALE_DAYS days.
export const STALE_ISSUES_SQL =
  "SELECT p.id::text AS project_id, p.name AS project_name, i.id::text AS issue_id, i.number, i.title, i.priority, i.status, u.full_name AS assignee, " +
  "floor(extract(epoch FROM now() - i.updated_at) / 86400)::int AS days_since_update " +
  "FROM issues i JOIN repositories r ON r.id = i.repository_id JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = i.assignee_id " +
  `WHERE i.status IN ('open', 'in_progress') AND i.priority IN ('high', 'critical') AND i.updated_at < now() - interval '${STALE_DAYS} days' ` +
  `AND ${managerSql("$1", "p.id")} ORDER BY (i.priority = 'critical') DESC, i.updated_at ASC, i.id LIMIT ${ROW_LIMIT}`;

// Q3: team members who have never reviewed a pull request in their project, with how active they are otherwise.
export const NON_REVIEWERS_SQL =
  "SELECT p.id::text AS project_id, p.name AS project_name, u.id::text AS user_id, u.full_name, u.role AS user_role, c.commits, c.prs_opened " +
  "FROM (SELECT DISTINCT t.project_id, tm.user_id FROM teams t JOIN team_members tm ON tm.team_id = t.id) m " +
  "JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = m.user_id " +
  "LEFT JOIN (SELECT DISTINCT r.project_id, rv.reviewer_id FROM pr_reviews rv JOIN pull_requests x ON x.id = rv.pull_request_id JOIN repositories r ON r.id = x.repository_id) reviewed " +
  "ON reviewed.project_id = m.project_id AND reviewed.reviewer_id = m.user_id CROSS JOIN LATERAL contribution_counts(u.id, p.id) c " +
  `WHERE reviewed.reviewer_id IS NULL AND ${managerSql("$1", "p.id")} ORDER BY c.commits DESC, p.id, u.id LIMIT ${ROW_LIMIT}`;

// Q4a: histogram of contribution scores in eight equal-width buckets (empty ranges still appear with 0 members).
// Q4b: summary statistics for the same scores. Both cover only the members of projects the viewer manages.
const SCORES = `SELECT m.score FROM member_contribution_v m WHERE ${managerSql("$1", "m.project_id")}`;
export const DISTRIBUTION_SQL =
  `WITH scores AS (${SCORES}), bounds AS (SELECT min(score) AS lo, max(score) + 0.01 AS hi FROM scores), ` +
  "counted AS (SELECT width_bucket(s.score, b.lo, b.hi, 8) AS bucket, count(*) AS members FROM scores s CROSS JOIN bounds b GROUP BY 1) " +
  "SELECT g.bucket::int AS bucket, round(b.lo + (g.bucket - 1) * (b.hi - b.lo) / 8, 0) AS from_score, round(b.lo + g.bucket * (b.hi - b.lo) / 8, 0) AS to_score, " +
  "coalesce(c.members, 0) AS members FROM generate_series(1, 8) AS g(bucket) CROSS JOIN bounds b LEFT JOIN counted c USING (bucket) ORDER BY g.bucket";
export const SCORE_STATS_SQL =
  `WITH scores AS (${SCORES}) SELECT count(*) AS members, min(score) AS min, ` +
  "percentile_cont(0.25) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p25, percentile_cont(0.50) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS median, " +
  "percentile_cont(0.75) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p75, percentile_cont(0.90) WITHIN GROUP (ORDER BY score)::numeric(10,1) AS p90, " +
  "max(score) AS max, round(avg(score), 1) AS mean, round(stddev_pop(score), 1) AS stddev FROM scores";

// PostgreSQL returns bigint and numeric columns as strings; the page works with numbers.
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type Raw = Record<string, unknown>;
export type TopContributor = { project_id: string; project_name: string; rank: number; user_id: string; full_name: string; score: number; pct_of_project: number | null };
export type StaleIssue = { project_id: string; project_name: string; issue_id: string; number: number; title: string; priority: string; status: string; assignee: string | null; days_since_update: number };
export type NonReviewer = { project_id: string; project_name: string; user_id: string; full_name: string; user_role: string; commits: number; prs_opened: number };
export type Bucket = { bucket: number; from_score: number | null; to_score: number | null; members: number };
export type ScoreStats = { members: number; min: number | null; p25: number | null; median: number | null; p75: number | null; p90: number | null; max: number | null; mean: number | null; stddev: number | null };
export type Dashboard = { topContributors: TopContributor[]; staleIssues: StaleIssue[]; nonReviewers: NonReviewer[]; buckets: Bucket[]; stats: ScoreStats };

export const toTopContributor = (r: Raw): TopContributor => ({ project_id: String(r.project_id), project_name: String(r.project_name), rank: num(r.rank), user_id: String(r.user_id), full_name: String(r.full_name), score: num(r.score), pct_of_project: numOrNull(r.pct_of_project) });
export const toStaleIssue = (r: Raw): StaleIssue => ({ project_id: String(r.project_id), project_name: String(r.project_name), issue_id: String(r.issue_id), number: num(r.number), title: String(r.title), priority: String(r.priority), status: String(r.status), assignee: r.assignee === null || r.assignee === undefined ? null : String(r.assignee), days_since_update: num(r.days_since_update) });
export const toNonReviewer = (r: Raw): NonReviewer => ({ project_id: String(r.project_id), project_name: String(r.project_name), user_id: String(r.user_id), full_name: String(r.full_name), user_role: String(r.user_role), commits: num(r.commits), prs_opened: num(r.prs_opened) });
export const toBucket = (r: Raw): Bucket => ({ bucket: num(r.bucket), from_score: numOrNull(r.from_score), to_score: numOrNull(r.to_score), members: num(r.members) });
export const toStats = (r: Raw | undefined): ScoreStats => ({ members: num(r?.members), min: numOrNull(r?.min), p25: numOrNull(r?.p25), median: numOrNull(r?.median), p75: numOrNull(r?.p75), p90: numOrNull(r?.p90), max: numOrNull(r?.max), mean: numOrNull(r?.mean), stddev: numOrNull(r?.stddev) });

export async function getDashboard(viewerId: string, run: RunQuery<Raw> = query<Raw>): Promise<Dashboard> {
  const args = [viewerId];
  const [top, stale, non, dist, stats] = await Promise.all([
    run(TOP_CONTRIBUTORS_SQL, args), run(STALE_ISSUES_SQL, args), run(NON_REVIEWERS_SQL, args), run(DISTRIBUTION_SQL, args), run(SCORE_STATS_SQL, args),
  ]);
  const statsRow = toStats(stats[0]);
  // With no members there is nothing to bucket: the histogram query then has NULL bounds, so every bucket is shown empty.
  return {
    topContributors: top.map(toTopContributor), staleIssues: stale.map(toStaleIssue), nonReviewers: non.map(toNonReviewer),
    buckets: statsRow.members === 0 ? [] : dist.map(toBucket), stats: statsRow,
  };
}
