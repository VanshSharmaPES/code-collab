import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { SCORE_WEIGHTS, listMemberContributions, listProjects, type MemberContribution, type ProjectOption } from "@/lib/contributions";

export const metadata: Metadata = { title: "Contributions | CodeCollab" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ContributionsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const sp = await searchParams;
  const requested = typeof sp.project === "string" ? parseId(sp.project) : null;

  let data: { projects: ProjectOption[]; project: ProjectOption | null; members: MemberContribution[] } | null = null;
  try {
    const projects = await listProjects();
    const project = projects.find((p) => p.id === requested) ?? projects[0] ?? null;
    data = { projects, project, members: project ? await listMemberContributions(project.id) : [] };
  } catch (err) {
    console.error("Contributions page: could not load contributions:", err instanceof Error ? err.message : err);
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Contributions</h1>

      {data === null ? (
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">Contributions could not be loaded right now. Please try again later.</p>
      ) : data.project === null ? (
        <p className="mt-6 text-zinc-600 dark:text-zinc-400">No projects found.</p>
      ) : (
        <>
          <form method="get" className="mt-6 flex flex-wrap items-end gap-3 text-sm">
            <label>Project
              <select name="project" defaultValue={data.project.id} className="ml-2 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <button type="submit" className="rounded border border-zinc-400 px-3 py-1">Show</button>
          </form>

          {data.members.length === 0 ? (
            <p className="mt-6 text-zinc-600 dark:text-zinc-400">This project has no team members yet.</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Member contributions in {data.project.name}</caption>
                <thead>
                  <tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className="px-3 py-2 font-medium">Member</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Commits</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">PRs opened</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">PRs merged</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Reviews</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Issues closed</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.user_id} className="border-b border-zinc-200 dark:border-zinc-800">
                      <td className="px-3 py-2"><Link href={`/contributions/${data.project!.id}/${m.user_id}`} className="underline">{m.full_name}</Link></td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.commits}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.prs_opened}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.prs_merged}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.reviews_given}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.issues_closed}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{m.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-zinc-600 dark:text-zinc-400">
            Score = {SCORE_WEIGHTS.commits} × commits + {SCORE_WEIGHTS.prs_merged} × merged PRs + {SCORE_WEIGHTS.reviews_given} × reviews + {SCORE_WEIGHTS.issues_closed} × issues closed
            by the member&apos;s merged PRs. Select a member to see the records behind their numbers.
          </p>
        </>
      )}
    </main>
  );
}
