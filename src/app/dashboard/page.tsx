import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { STALE_DAYS, getDashboard, type Dashboard } from "@/lib/dashboard";
import { formatLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard | CodeCollab" };

const TH = "px-3 py-2 font-medium";
const ROW = "border-b border-zinc-200 dark:border-zinc-800";
const H2 = "text-lg font-semibold";
const NOTE = "mt-1 text-xs text-zinc-600 dark:text-zinc-400";

export default async function DashboardPage() {
  const session = await requireSession();

  let data: Dashboard | null = null;
  try {
    data = await getDashboard(session.userId);
  } catch (err) {
    console.error("Dashboard page: could not load the dashboard:", err instanceof Error ? err.message : err);
  }

  if (data === null) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">The dashboard could not be loaded right now. Please try again later.</p>
      </main>
    );
  }

  const { topContributors, staleIssues, nonReviewers, buckets, stats } = data;
  const empty = stats.members === 0 && staleIssues.length === 0;
  const widest = Math.max(1, ...buckets.map((b) => b.members));

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className={NOTE}>Four views over the projects you manage as a mentor or team lead. Members see their own numbers on the contributions page.</p>

      {empty ? (
        <p className="mt-6 text-zinc-600 dark:text-zinc-400">You do not manage a project with team members yet, so there is nothing to show.</p>
      ) : (
        <div className="mt-8 flex flex-col gap-10">
          <section>
            <h2 className={H2}>Top contributors</h2>
            <p className={NOTE}>The three highest contribution scores in each project, with their share of the project total.</p>
            {topContributors.length === 0 ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No data.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Top contributors per project</caption>
                  <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className={TH}>Project</th><th scope="col" className={TH}>Rank</th><th scope="col" className={TH}>Member</th>
                    <th scope="col" className={`${TH} text-right`}>Score</th><th scope="col" className={`${TH} text-right`}>Share</th>
                  </tr></thead>
                  <tbody>
                    {topContributors.map((c) => (
                      <tr key={`${c.project_id}-${c.user_id}`} className={ROW}>
                        <td className="px-3 py-2">{c.project_name}</td><td className="px-3 py-2">{c.rank}</td><td className="px-3 py-2">{c.full_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.score}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.pct_of_project === null ? "—" : `${c.pct_of_project}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className={H2}>Stale high-priority issues</h2>
            <p className={NOTE}>High and critical issues that are still open or in progress and have not changed for more than {STALE_DAYS} days. Critical first, then the longest neglected (at most 50).</p>
            {staleIssues.length === 0 ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">None.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Stale high-priority issues</caption>
                  <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className={TH}>Issue</th><th scope="col" className={TH}>Project</th><th scope="col" className={TH}>Priority</th>
                    <th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Assignee</th><th scope="col" className={`${TH} text-right`}>Days idle</th>
                  </tr></thead>
                  <tbody>
                    {staleIssues.map((i) => (
                      <tr key={i.issue_id} className={ROW}>
                        <td className="px-3 py-2"><Link href={`/issues/${i.issue_id}`} className="underline">#{i.number} {i.title}</Link></td>
                        <td className="px-3 py-2">{i.project_name}</td><td className="px-3 py-2 capitalize">{i.priority}</td>
                        <td className="px-3 py-2 capitalize">{formatLabel(i.status)}</td><td className="px-3 py-2">{i.assignee ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.days_since_update}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className={H2}>Members who never review</h2>
            <p className={NOTE}>Team members with no review on any pull request of their project, most active first (at most 50).</p>
            {nonReviewers.length === 0 ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Everyone has reviewed at least once.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Members who never review</caption>
                  <thead><tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className={TH}>Member</th><th scope="col" className={TH}>Project</th><th scope="col" className={TH}>Role</th>
                    <th scope="col" className={`${TH} text-right`}>Commits</th><th scope="col" className={`${TH} text-right`}>PRs opened</th>
                  </tr></thead>
                  <tbody>
                    {nonReviewers.map((m) => (
                      <tr key={`${m.project_id}-${m.user_id}`} className={ROW}>
                        <td className="px-3 py-2">{m.full_name}</td><td className="px-3 py-2">{m.project_name}</td><td className="px-3 py-2 capitalize">{m.user_role}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.commits}</td><td className="px-3 py-2 text-right tabular-nums">{m.prs_opened}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className={H2}>Contribution distribution</h2>
            <p className={NOTE}>How many members fall into each of eight equal score ranges, and summary statistics for {stats.members} members.</p>
            {buckets.length === 0 ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No data.</p> : (
              <ol className="mt-3 flex flex-col gap-1 text-sm" aria-label="Members per score range">
                {buckets.map((b) => (
                  <li key={b.bucket} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3">
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{b.from_score}–{b.to_score}</span>
                    <span className="h-4 rounded bg-zinc-100 dark:bg-zinc-900"><span className="block h-4 rounded bg-zinc-700 dark:bg-zinc-300" style={{ width: `${(b.members / widest) * 100}%` }} /></span>
                    <span className="text-right tabular-nums">{b.members}</span>
                  </li>
                ))}
              </ol>
            )}
            <dl className="mt-4 grid max-w-md grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
              {([["Minimum", stats.min], ["25th percentile", stats.p25], ["Median", stats.median], ["75th percentile", stats.p75], ["90th percentile", stats.p90], ["Maximum", stats.max], ["Mean", stats.mean], ["Standard deviation", stats.stddev]] as const).map(([label, v]) => (
                <div key={label} className="contents"><dt className="font-medium">{label}</dt><dd className="tabular-nums">{v ?? "—"}</dd></div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </main>
  );
}
