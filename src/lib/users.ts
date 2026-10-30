import "server-only";
import { query } from "@/lib/db";
import { participantSql } from "@/lib/project-access";

export const MAX_USERS = 200;

// Explicit column list: password_hash is deliberately never selected.
// Only the viewer ($2, the signed-in user) and the people who share a project with them are listed: the mentor, team
// leads and team members of every project the viewer takes part in (P1-07, the same rule as project-access.ts).
// Someone on no project sees only themselves. The alias pv must differ from the px, tx and tmx used inside participantSql.
export const LIST_USERS_SQL =
  "WITH mine AS (SELECT pv.id FROM projects pv WHERE " + participantSql("$2", "pv.id") + "), " +
  "people AS (SELECT mentor_id AS user_id FROM projects WHERE id IN (SELECT id FROM mine) " +
  "UNION SELECT lead_id FROM teams WHERE project_id IN (SELECT id FROM mine) " +
  "UNION SELECT tm.user_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.project_id IN (SELECT id FROM mine) " +
  "UNION SELECT $2::bigint) " +
  "SELECT id, full_name, email, role, github_username, created_at FROM users " +
  "WHERE id IN (SELECT user_id FROM people) ORDER BY id LIMIT $1";

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  github_username: string | null;
  created_at: Date | string;
};

export type UserListItem = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  githubUsername: string | null;
  createdAt: string;
};

// Copies only the known fields, so nothing extra on a row can reach the page.
export function toUserListItem(row: UserRow): UserListItem {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    githubUsername: row.github_username,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type RunQuery = (text: string, params: readonly unknown[]) => Promise<UserRow[]>;

export async function listUsers(viewer: string, run: RunQuery = query<UserRow>): Promise<UserListItem[]> {
  const rows = await run(LIST_USERS_SQL, [MAX_USERS, viewer]);
  return rows.map(toUserListItem);
}
