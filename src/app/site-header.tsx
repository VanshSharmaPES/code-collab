import Link from "next/link";
import { query } from "@/lib/db";
import { getSession } from "@/lib/session";
import { logoutAction } from "./login/actions";

// Every page of the app is reached from here. It shows nothing to a visitor without a session, and never decides what
// someone may see: each page and query still checks access itself.
const LINKS = [
  { href: "/issues", label: "Issues" },
  { href: "/pull-requests", label: "Pull requests" },
  { href: "/contributions", label: "Contributions" },
  { href: "/users", label: "Users" },
] as const;

async function displayName(userId: string): Promise<string | null> {
  try {
    return (await query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1::bigint", [userId]))[0]?.full_name ?? null;
  } catch (err) {
    console.error("Header: could not load the user's name:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function SiteHeader() {
  const session = await getSession();
  if (session === null) return null;
  const name = await displayName(session.userId);
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 text-sm">
        <Link href="/" className="font-semibold">CodeCollab</Link>
        <nav aria-label="Main" className="flex flex-wrap gap-4">
          {LINKS.map((l) => <Link key={l.href} href={l.href} className="underline">{l.label}</Link>)}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-zinc-600 dark:text-zinc-400">{name ?? "Signed in"} · <span className="capitalize">{session.role}</span></span>
          <form action={logoutAction}><button type="submit" className="rounded border border-zinc-400 px-3 py-1">Sign out</button></form>
        </div>
      </div>
    </header>
  );
}
