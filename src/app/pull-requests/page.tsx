import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { PR_STATUSES, isPullRequestStatus } from "@/lib/pull-request-input";
import { PAGE_SIZE, countPullRequests, listPullRequests, listRepositories, type PullRequestRow, type RepositoryOption } from "@/lib/pull-requests";
import { formatDate, formatLabel, parsePage } from "@/lib/format";

export const metadata: Metadata = { title: "Pull requests | CodeCollab" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PullRequestsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  const sp = await searchParams;
  const repositoryId = typeof sp.repository === "string" ? parseId(sp.repository) : null;
  const status = typeof sp.status === "string" && isPullRequestStatus(sp.status) ? sp.status : null;
  const page = parsePage(sp.page);
  const filters = { repositoryId, status };

  let data: { pullRequests: PullRequestRow[]; total: number; repositories: RepositoryOption[] } | null = null;
  try {
    const [pullRequests, total, repositories] = await Promise.all([
      listPullRequests(filters, page, PAGE_SIZE, session.userId),
      countPullRequests(filters, session.userId),
      listRepositories(session.userId),
    ]);
    data = { pullRequests, total, repositories };
  } catch (err) {
    console.error("Pull requests page: could not load pull requests:", err instanceof Error ? err.message : err);
  }

  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (repositoryId) q.set("repository", repositoryId);
    if (status) q.set("status", status);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/pull-requests?${s}` : "/pull-requests";
  };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Pull requests</h1>

      {data === null ? (
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">Pull requests could not be loaded right now. Please try again later.</p>
      ) : (
        <>
          <form method="get" className="mt-6 flex flex-wrap items-end gap-3 text-sm">
            <label>Repository
              <select name="repository" defaultValue={repositoryId ?? ""} className="ml-2 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                <option value="">All</option>
                {data.repositories.map((r) => <option key={r.id} value={r.id}>{r.project_name} / {r.name}</option>)}
              </select>
            </label>
            <label>Status
              <select name="status" defaultValue={status ?? ""} className="ml-2 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                <option value="">All</option>
                {PR_STATUSES.map((s) => <option key={s} value={s}>{formatLabel(s)}</option>)}
              </select>
            </label>
            <button type="submit" className="rounded border border-zinc-400 px-3 py-1">Filter</button>
          </form>

          {data.pullRequests.length === 0 ? (
            <p className="mt-6 text-zinc-600 dark:text-zinc-400">No pull requests found.</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Pull requests</caption>
                <thead>
                  <tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className="px-3 py-2 font-medium">Pull request</th>
                    <th scope="col" className="px-3 py-2 font-medium">Repository</th>
                    <th scope="col" className="px-3 py-2 font-medium">Author</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pullRequests.map((pr) => (
                    <tr key={pr.id} className="border-b border-zinc-200 dark:border-zinc-800">
                      <td className="px-3 py-2"><Link href={`/pull-requests/${pr.id}`} className="underline">#{pr.number} {pr.title}</Link></td>
                      <td className="px-3 py-2">{pr.repository_name}</td>
                      <td className="px-3 py-2">{pr.author_name ?? "—"}</td>
                      <td className="px-3 py-2 capitalize">{formatLabel(pr.status)}</td>
                      <td className="px-3 py-2">{formatDate(pr.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <nav aria-label="Pagination" className="mt-6 flex items-center gap-4 text-sm">
            {page > 1 && <Link href={pageHref(page - 1)} className="underline">Previous</Link>}
            <span>Page {page} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} · {data.total} pull requests</span>
            {page * PAGE_SIZE < data.total && <Link href={pageHref(page + 1)} className="underline">Next</Link>}
          </nav>
        </>
      )}
    </main>
  );
}
