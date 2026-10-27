import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { ACTION_ERRORS, PR_TRANSITIONS, availableActions } from "@/lib/pull-request-input";
import { PR_MIRRORED_READ_ONLY_MESSAGE, canChangePullRequest, getPullRequest, type PullRequestRow } from "@/lib/pull-requests";
import { formatDate, formatLabel } from "@/lib/format";
import { transitionPullRequestAction } from "../actions";

export const metadata: Metadata = { title: "Pull request | CodeCollab" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PullRequestDetailPage({ params, searchParams }: Props) {
  await requireSession();
  const id = parseId((await params).id);
  if (id === null) notFound();
  const { error } = await searchParams;
  const errorMessage = typeof error === "string" && Object.hasOwn(ACTION_ERRORS, error) ? ACTION_ERRORS[error as keyof typeof ACTION_ERRORS] : null;

  let pr: PullRequestRow | null;
  try {
    pr = await getPullRequest(id);
  } catch (err) {
    console.error("Pull request page: could not load the pull request:", err instanceof Error ? err.message : err);
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <p role="alert" className="text-red-700 dark:text-red-400">This pull request could not be loaded right now. Please try again later.</p>
      </main>
    );
  }
  if (pr === null) notFound();

  const actions = canChangePullRequest(pr) ? availableActions(pr.status) : [];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <p className="text-sm"><Link href="/pull-requests" className="underline">← All pull requests</Link></p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">#{pr.number} {pr.title}</h1>
      {errorMessage && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{errorMessage}</p>}
      {!canChangePullRequest(pr) && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{PR_MIRRORED_READ_ONLY_MESSAGE}</p>}
      {actions.length > 0 && (
        <div className="mt-4 flex gap-3">
          {actions.map((a) => (
            <form key={a} action={transitionPullRequestAction}>
              <input type="hidden" name="id" value={pr.id} />
              <input type="hidden" name="action" value={a} />
              <button type="submit" className="rounded border border-zinc-400 px-3 py-1 text-sm">{PR_TRANSITIONS[a].label}</button>
            </form>
          ))}
        </div>
      )}
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">Repository</dt><dd>{pr.project_name} / {pr.repository_name}</dd>
        <dt className="font-medium">Status</dt><dd className="capitalize">{formatLabel(pr.status)}</dd>
        <dt className="font-medium">Author</dt><dd>{pr.author_name ?? "—"}</dd>
        <dt className="font-medium">Merged by</dt><dd>{pr.merged_by_name ?? "—"}</dd>
        <dt className="font-medium">Created</dt><dd>{formatDate(pr.created_at)}</dd>
        <dt className="font-medium">Updated</dt><dd>{formatDate(pr.updated_at)}</dd>
        <dt className="font-medium">Merged</dt><dd>{formatDate(pr.merged_at)}</dd>
      </dl>
      {/* Plain text: React escapes it, and whitespace-pre-wrap keeps the line breaks. */}
      <div className="mt-6 whitespace-pre-wrap break-words rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        {pr.description ?? <span className="text-zinc-500">No description.</span>}
      </div>
    </main>
  );
}
