import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { MIRRORED_READ_ONLY_MESSAGE, canEditIssue, getIssue, type IssueRow } from "@/lib/issues";
import { updateIssueAction } from "../../actions";
import { IssueForm } from "../../issue-form";

export const metadata: Metadata = { title: "Edit issue | CodeCollab" };

export default async function EditIssuePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const id = parseId((await params).id);
  if (id === null) notFound();

  let issue: IssueRow | null;
  try {
    issue = await getIssue(id, session.userId);
  } catch (err) {
    console.error("Edit issue page: could not load the issue:", err instanceof Error ? err.message : err);
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <p role="alert" className="text-red-700 dark:text-red-400">This issue could not be loaded right now. Please try again later.</p>
      </main>
    );
  }
  if (issue === null) notFound();
  if (!canEditIssue(issue)) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <p role="alert" className="text-red-700 dark:text-red-400">{MIRRORED_READ_ONLY_MESSAGE}</p>
        <p className="mt-4 text-sm"><Link href={`/issues/${issue.id}`} className="underline">← Back to the issue</Link></p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Edit #{issue.number}</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{issue.project_name} / {issue.repository_name}</p>
      <IssueForm
        action={updateIssueAction.bind(null, issue.id)}
        initial={{ title: issue.title, body: issue.body ?? "", status: issue.status, priority: issue.priority, repositoryId: issue.repository_id }}
        submitLabel="Save changes"
        cancelHref={`/issues/${issue.id}`}
      />
    </main>
  );
}
