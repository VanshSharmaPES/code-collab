import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { listRepositories, type RepositoryOption } from "@/lib/issues";
import { createIssueAction } from "../actions";
import { IssueForm } from "../issue-form";

export const metadata: Metadata = { title: "New issue | CodeCollab" };

export default async function NewIssuePage() {
  await requireSession();
  let repositories: RepositoryOption[] | null = null;
  try {
    repositories = await listRepositories();
  } catch (err) {
    console.error("New issue page: could not load repositories:", err instanceof Error ? err.message : err);
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New issue</h1>
      {repositories === null ? (
        <p role="alert" className="mt-4 text-red-700 dark:text-red-400">The form could not be loaded right now. Please try again later.</p>
      ) : (
        <IssueForm
          action={createIssueAction}
          repositories={repositories.map((r) => ({ id: r.id, name: r.name, projectName: r.project_name }))}
          initial={{ title: "", body: "", status: "open", priority: "medium", repositoryId: "" }}
          submitLabel="Create issue"
          cancelHref="/issues"
        />
      )}
    </main>
  );
}
