import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { listUsers, type UserListItem } from "@/lib/users";

export const metadata: Metadata = { title: "Users | CodeCollab" };

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export default async function UsersPage() {
  // Runs before any query: without a valid session no user data is read or rendered.
  const session = await requireSession();

  let users: UserListItem[] | null = null;
  try {
    users = await listUsers(session.userId);
  } catch (err) {
    console.error("Users page: could not load users:", err instanceof Error ? err.message : err);
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>

      {users === null ? (
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">
          Users could not be loaded right now. Please try again later.
        </p>
      ) : users.length === 0 ? (
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">No users found.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">You and the people who share a project with you</caption>
            <thead>
              <tr className="border-b border-zinc-300 dark:border-zinc-700">
                <th scope="col" className="px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 font-medium">Email</th>
                <th scope="col" className="px-3 py-2 font-medium">Role</th>
                <th scope="col" className="px-3 py-2 font-medium">GitHub</th>
                <th scope="col" className="px-3 py-2 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-zinc-200 dark:border-zinc-800">
                  <td className="px-3 py-2">{user.fullName}</td>
                  <td className="px-3 py-2">{user.email}</td>
                  <td className="px-3 py-2 capitalize">{user.role}</td>
                  <td className="px-3 py-2">{user.githubUsername ?? "—"}</td>
                  <td className="px-3 py-2">{dateFormat.format(new Date(user.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
