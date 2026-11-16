import "server-only";
import { query } from "@/lib/db";
import { managerSql, participantSql } from "@/lib/project-access";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;
type Raw = Record<string, unknown>;

// The home page (P2-13): what a signed-in person has to look at first, whatever their role. Every query is limited to
// the projects the viewer takes part in (participantSql, P1-07) or to the viewer's own rows, and the viewer ($1) is
// always the signed-in user, never a request value. The numbers come from the views of P1-11 and P1-12, so
// db/schema/05 and 06 must be applied.
export const ACTIVITY_LIMIT = 8; // written as the literal LIMIT 8 in HOME_ACTIVITY_SQL; a test keeps the two equal

export const HOME_USER_SQL = `SELECT full_name FROM users WHERE id = $1::bigint`;

// The projects of the viewer, one row each, with the project's own numbers and whether the viewer manages it.
export const HOME_PROJECTS_SQL =
  `SELECT d.project_id::text AS project_id, d.project_name, d.project_status, d.mentor_name, d.members, d.open_issues, ` +
  `d.urgent_open_issues, d.open_prs, d.approved_prs, d.merged_prs, d.total_commits, d.commits_last_7_days, d.last_commit_at, ` +
  `${managerSql("$1", "d.project_id")} AS is_manager ` +
  `FROM project_dashboard_v d WHERE ${participantSql("$1", "d.project_id")} ORDER BY d.project_name, d.project_id`;

// The viewer's own contribution in each project they are a team member of: only their own rows.
export const HOME_MY_CONTRIBUTIONS_SQL =
  `SELECT m.project_id::text AS project_id, m.commits::int AS commits, m.prs_opened::int AS prs_opened, ` +
  `m.prs_merged::int AS prs_merged, m.reviews_given::int AS reviews_given, m.issues_closed::int AS issues_closed, ` +
  `m.score::float8 AS score FROM member_contribution_v m WHERE m.user_id = $1::bigint`;

// The most recently changed issues and pull requests across those projects.
export const HOME_ACTIVITY_SQL =
  `SELECT * FROM (` +
  `(SELECT 'issue' AS kind, i.id::text AS id, i.number, i.title, i.status, i.updated_at, p.name AS project_name ` +
  `FROM issues i JOIN repositories r ON r.id = i.repository_id JOIN projects p ON p.id = r.project_id ` +
  `WHERE ${participantSql("$1", "r.project_id")} ORDER BY i.updated_at DESC, i.id DESC LIMIT 8) ` +
  `UNION ALL ` +
  `(SELECT 'pull_request' AS kind, x.id::text AS id, x.number, x.title, x.status, x.updated_at, p.name AS project_name ` +
  `FROM pull_requests x JOIN repositories r ON r.id = x.repository_id JOIN projects p ON p.id = r.project_id ` +
  `WHERE ${participantSql("$1", "r.project_id")} ORDER BY x.updated_at DESC, x.id DESC LIMIT 8)` +
  `) a ORDER BY a.updated_at DESC, a.kind, a.id DESC LIMIT 8`;

// PostgreSQL returns bigint and numeric columns as strings; the page works with numbers.
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type MyContribution = { commits: number; prs_opened: number; prs_merged: number; reviews_given: number; issues_closed: number; score: number };
export type HomeProject = {
  project_id: string; project_name: string; archived: boolean; mentor_name: string | null; members: number;
  open_issues: number; urgent_open_issues: number; open_prs: number; approved_prs: number; merged_prs: number;
  total_commits: number; commits_last_7_days: number; last_commit_at: Date | string | null;
  is_manager: boolean; mine: MyContribution | null;
};
export type ActivityItem = { kind: "issue" | "pull_request"; id: string; number: number; title: string; status: string; updated_at: Date | string; project_name: string };
export type Home = { name: string | null; projects: HomeProject[]; activity: ActivityItem[] };

export const toMyContribution = (r: Raw): MyContribution => ({
  commits: num(r.commits), prs_opened: num(r.prs_opened), prs_merged: num(r.prs_merged),
  reviews_given: num(r.reviews_given), issues_closed: num(r.issues_closed), score: num(r.score),
});

export const toHomeProject = (r: Raw, mine: MyContribution | null): HomeProject => ({
  project_id: String(r.project_id), project_name: String(r.project_name), archived: r.project_status === "archived",
  mentor_name: r.mentor_name === null || r.mentor_name === undefined ? null : String(r.mentor_name), members: num(r.members),
  open_issues: num(r.open_issues), urgent_open_issues: num(r.urgent_open_issues), open_prs: num(r.open_prs),
  approved_prs: num(r.approved_prs), merged_prs: num(r.merged_prs), total_commits: num(r.total_commits),
  commits_last_7_days: num(r.commits_last_7_days),
  last_commit_at: r.last_commit_at === null || r.last_commit_at === undefined ? null : (r.last_commit_at as Date | string),
  is_manager: r.is_manager === true, mine,
});

export const toActivityItem = (r: Raw): ActivityItem => ({
  kind: r.kind === "pull_request" ? "pull_request" : "issue", id: String(r.id), number: num(r.number), title: String(r.title),
  status: String(r.status), updated_at: r.updated_at as Date | string, project_name: String(r.project_name),
});

// The page links an item to /issues/<id> or /pull-requests/<id>; the id is a database id rendered as text.
export const activityHref = (a: ActivityItem): string => `${a.kind === "issue" ? "/issues" : "/pull-requests"}/${a.id}`;

export async function getHome(viewerId: string, run: RunQuery<Raw> = query<Raw>): Promise<Home> {
  const args = [viewerId];
  const [user, projects, mine, activity] = await Promise.all([
    run(HOME_USER_SQL, args), run(HOME_PROJECTS_SQL, args), run(HOME_MY_CONTRIBUTIONS_SQL, args), run(HOME_ACTIVITY_SQL, args),
  ]);
  const own = new Map(mine.map((r) => [String(r.project_id), toMyContribution(r)]));
  return {
    name: user[0]?.full_name === undefined || user[0]?.full_name === null ? null : String(user[0].full_name),
    projects: projects.map((r) => toHomeProject(r, own.get(String(r.project_id)) ?? null)),
    activity: activity.map(toActivityItem),
  };
}
