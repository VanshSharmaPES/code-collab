import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { MIRRORED_READ_ONLY_MESSAGE, canEditIssue, getIssue, type IssueRow } from "@/lib/issues";
import { formatDate, formatLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Issue | CodeCollab" };

export default async function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const id = parseId((await params).id);
  if (id === null) notFound();

  let issue: IssueRow | null;
  try {
    issue = await getIssue(id);
  } catch (err) {
    console.error("Issue page: could not load the issue:", err instanceof Error ? err.message : err);
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <p role="alert" className="text-red-700 dark:text-red-400">This issue could not be loaded right now. Please try again later.</p>
      </main>
    );
  }
  if (issue === null) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <p className="text-sm"><Link href="/issues" className="underline">← All issues</Link></p>
      <div className="mt-4 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">#{issue.number} {issue.title}</h1>
        {canEditIssue(issue) && (
          <Link href={`/issues/${issue.id}/edit`} className="shrink-0 rounded border border-zinc-400 px-3 py-1 text-sm">Edit</Link>
        )}
      </div>
      {!canEditIssue(issue) && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{MIRRORED_READ_ONLY_MESSAGE}</p>}
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">Repository</dt><dd>{issue.project_name} / {issue.repository_name}</dd>
        <dt className="font-medium">Status</dt><dd className="capitalize">{formatLabel(issue.status)}</dd>
        <dt className="font-medium">Priority</dt><dd className="capitalize">{issue.priority}</dd>
        <dt className="font-medium">Author</dt><dd>{issue.author_name ?? "—"}</dd>
        <dt className="font-medium">Assignee</dt><dd>{issue.assignee_name ?? "—"}</dd>
        <dt className="font-medium">Created</dt><dd>{formatDate(issue.created_at)}</dd>
        <dt className="font-medium">Updated</dt><dd>{formatDate(issue.updated_at)}</dd>
        <dt className="font-medium">Closed</dt><dd>{formatDate(issue.closed_at)}</dd>
      </dl>
      {/* Plain text: React escapes it, and whitespace-pre-wrap keeps the line breaks. */}
      <div className="mt-6 whitespace-pre-wrap break-words rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        {issue.body ?? <span className="text-zinc-500">No description.</span>}
      </div>
    </main>
  );
}
