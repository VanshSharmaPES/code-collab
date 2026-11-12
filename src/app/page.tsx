import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireSession } from "@/lib/session";
import { activityHref, getHome, type Home, type HomeProject } from "@/lib/home";
import { formatDate, formatLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Home | CodeCollab" };

const NOTE = "text-sm text-zinc-600 dark:text-zinc-400";
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const BOX = "rounded border border-zinc-200 p-4 dark:border-zinc-800";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className={NOTE}>{label}</dt><dd className="font-medium tabular-nums">{children}</dd></div>;
}

function ProjectCard({ p }: { p: HomeProject }) {
  return (
    <li className={BOX}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold"><Link href={`/contributions?project=${p.project_id}`} className="underline">{p.project_name}</Link></h3>
        <span className="rounded border border-zinc-300 px-2 text-xs dark:border-zinc-700">{p.is_manager ? "You manage this" : "Member"}</span>
        {p.archived && <span className="rounded border border-zinc-300 px-2 text-xs dark:border-zinc-700">Archived</span>}
      </div>
      <p className={`mt-1 ${NOTE}`}>Mentor: {p.mentor_name ?? "none"} · {p.members} {p.members === 1 ? "member" : "members"}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Stat label="Open issues">{p.open_issues}{p.urgent_open_issues > 0 && <span className="ml-1 text-xs font-normal text-red-700 dark:text-red-400">({p.urgent_open_issues} urgent)</span>}</Stat>
        <Stat label="Pull requests">{p.open_prs} open · {p.approved_prs} approved · {p.merged_prs} merged</Stat>
        <Stat label="Commits">{p.total_commits}{p.commits_last_7_days > 0 && <span className="ml-1 text-xs font-normal">({p.commits_last_7_days} this week)</span>}</Stat>
        <Stat label="Last commit">{formatDate(p.last_commit_at)}</Stat>
      </dl>

      <div className="mt-3 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
        {p.mine ? (
          <p><span className="font-medium">Your contribution:</span> score <span className="font-medium tabular-nums">{p.mine.score}</span> · {plural(p.mine.commits, "commit")} · {p.mine.prs_merged} {p.mine.prs_merged === 1 ? "PR" : "PRs"} merged · {plural(p.mine.reviews_given, "review")} · {plural(p.mine.issues_closed, "issue")} closed</p>
        ) : (
          <p className={NOTE}>
            {p.is_manager ? "You manage this project rather than work in it, so there is no contribution of your own to show." : "You are not on a team in this project, so no contribution is counted for you."}{" "}
            <Link href={`/contributions?project=${p.project_id}`} className="underline">See the members&apos; contributions</Link>.
          </p>
        )}
      </div>
    </li>
  );
}

function HomeBody({ data, role }: { data: Home; role: string }) {
  const first = data.name?.split(" ")[0];
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{first ? `Welcome, ${first}` : "Welcome"}</h1>
      <p className={`mt-1 ${NOTE}`}>You are signed in as a <span className="capitalize">{role}</span>. Here is where your projects stand.</p>

      <section className="mt-8" aria-labelledby="projects-h">
        <h2 id="projects-h" className="text-lg font-semibold">Your projects</h2>
        {data.projects.length === 0 ? (
          <p className={`mt-2 ${NOTE}`}>You are not on any project yet. Once a mentor or team lead adds you to a team, it appears here.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-4">{data.projects.map((p) => <ProjectCard key={p.project_id} p={p} />)}</ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="activity-h">
        <h2 id="activity-h" className="text-lg font-semibold">Recent activity</h2>
        {data.activity.length === 0 ? (
          <p className={`mt-2 ${NOTE}`}>Nothing has changed in your projects yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {data.activity.map((a) => (
              <li key={`${a.kind}-${a.id}`} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{a.kind === "issue" ? "Issue" : "Pull request"}</span>
                <Link href={activityHref(a)} className="underline">#{a.number} {a.title}</Link>
                <span className={`ml-auto ${NOTE}`}>{a.project_name} · <span className="capitalize">{formatLabel(a.status)}</span> · {formatDate(a.updated_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// The session cookie is read at request time, so everything personal sits behind a Suspense boundary. The proxy has
// already sent visitors without a session to /login, and requireSession checks again before any query runs.
async function HomeContent() {
  const session = await requireSession();
  let data: Home | null = null;
  try {
    data = await getHome(session.userId);
  } catch (err) {
    console.error("Home page: could not load the overview:", err instanceof Error ? err.message : err);
  }
  if (data === null) return <p role="alert" className="mt-4 text-red-700 dark:text-red-400">Your overview could not be loaded right now. Please try again later.</p>;
  return <HomeBody data={data} role={session.role} />;
}

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <Suspense fallback={<p role="status" className={NOTE}>Loading your overview…</p>}>
        <HomeContent />
      </Suspense>
    </main>
  );
}
