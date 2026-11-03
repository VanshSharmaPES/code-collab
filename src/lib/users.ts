import "server-only";
import { query } from "@/lib/db";

export const MAX_USERS = 200;

// Explicit column list: password_hash is deliberately never selected.
export const LIST_USERS_SQL =
  "SELECT id, full_name, email, role, github_username, created_at FROM users ORDER BY id LIMIT $1";

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

export async function listUsers(run: RunQuery = query<UserRow>): Promise<UserListItem[]> {
  const rows = await run(LIST_USERS_SQL, [MAX_USERS]);
  return rows.map(toUserListItem);
}
