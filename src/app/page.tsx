import Link from "next/link";

// The proxy sends visitors without a session back here, so every link below is safe to show to everyone.
const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/issues", label: "Issues" },
  { href: "/pull-requests", label: "Pull requests" },
  { href: "/users", label: "Users" },
] as const;

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">CodeCollab</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Collaborative GitHub activity and team contributions dashboard.
      </p>
      <nav aria-label="Main">
        <ul className="flex flex-wrap justify-center gap-4 text-sm">
          {LINKS.map((l) => (
            <li key={l.href}><Link href={l.href} className="underline">{l.label}</Link></li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
