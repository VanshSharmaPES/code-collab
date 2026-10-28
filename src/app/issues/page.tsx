import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { ISSUE_STATUSES, parseId } from "@/lib/issue-input";
import { PAGE_SIZE, countIssues, listIssues, listRepositories, type IssueRow, type RepositoryOption } from "@/lib/issues";
import { formatDate, formatLabel, parsePage } from "@/lib/format";

export const metadata: Metadata = { title: "Issues | CodeCollab" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function IssuesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSession();
  const sp = await searchParams;
  const repositoryId = typeof sp.repository === "string" ? parseId(sp.repository) : null;
  const status = typeof sp.status === "string" && (ISSUE_STATUSES as readonly string[]).includes(sp.status) ? sp.status : null;
  const page = parsePage(sp.page);
  const filters = { repositoryId, status };

  let data: { issues: IssueRow[]; total: number; repositories: RepositoryOption[] } | null = null;
  try {
    const [issues, total, repositories] = await Promise.all([listIssues(filters, page), countIssues(filters), listRepositories()]);
    data = { issues, total, repositories };
  } catch (err) {
    console.error("Issues page: could not load issues:", err instanceof Error ? err.message : err);
  }

  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (repositoryId) q.set("repository", repositoryId);
    if (status) q.set("status", status);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/issues?${s}` : "/issues";
  };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
        <Link href="/issues/new" className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">New issue</Link>
      </div>

      {data === null ? (
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">Issues could not be loaded right now. Please try again later.</p>
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
                {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{formatLabel(s)}</option>)}
              </select>
            </label>
            <button type="submit" className="rounded border border-zinc-400 px-3 py-1">Filter</button>
          </form>

          {data.issues.length === 0 ? (
            <p className="mt-6 text-zinc-600 dark:text-zinc-400">No issues found.</p>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Issues</caption>
                <thead>
                  <tr className="border-b border-zinc-300 dark:border-zinc-700">
                    <th scope="col" className="px-3 py-2 font-medium">Issue</th>
                    <th scope="col" className="px-3 py-2 font-medium">Repository</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 font-medium">Priority</th>
                    <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.issues.map((i) => (
                    <tr key={i.id} className="border-b border-zinc-200 dark:border-zinc-800">
                      <td className="px-3 py-2"><Link href={`/issues/${i.id}`} className="underline">#{i.number} {i.title}</Link></td>
                      <td className="px-3 py-2">{i.repository_name}</td>
                      <td className="px-3 py-2 capitalize">{formatLabel(i.status)}</td>
                      <td className="px-3 py-2 capitalize">{i.priority}</td>
                      <td className="px-3 py-2">{formatDate(i.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <nav aria-label="Pagination" className="mt-6 flex items-center gap-4 text-sm">
            {page > 1 && <Link href={pageHref(page - 1)} className="underline">Previous</Link>}
            <span>Page {page} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} · {data.total} issues</span>
            {page * PAGE_SIZE < data.total && <Link href={pageHref(page + 1)} className="underline">Next</Link>}
          </nav>
        </>
      )}
    </main>
  );
}
