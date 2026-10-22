"use server";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId, parseIssueForm, type IssueFormState } from "@/lib/issue-input";
import { RepositoryNotFoundError, createIssue, updateIssue } from "@/lib/issues";

const SAVE_FAILED = "The issue could not be saved right now. Please try again.";

// Server actions are public POST endpoints, so each one checks the session itself.
export async function createIssueAction(_prev: IssueFormState, formData: FormData): Promise<IssueFormState> {
  const session = await requireSession();
  const parsed = parseIssueForm(formData, { requireRepository: true });
  if (!parsed.ok) return { values: parsed.values, errors: parsed.errors };

  let id: string;
  try {
    id = await createIssue(parsed.repositoryId as string, parsed.input, session.userId);
  } catch (err) {
    if (err instanceof RepositoryNotFoundError) {
      return { values: { ...parsed.input, body: parsed.input.body ?? "", repositoryId: parsed.repositoryId as string }, errors: { repositoryId: "That repository does not exist." } };
    }
    console.error("Create issue failed:", err instanceof Error ? err.message : err);
    return { values: { ...parsed.input, body: parsed.input.body ?? "", repositoryId: parsed.repositoryId as string }, message: SAVE_FAILED };
  }
  redirect(`/issues/${id}`);
}

export async function updateIssueAction(issueId: string, _prev: IssueFormState, formData: FormData): Promise<IssueFormState> {
  const session = await requireSession();
  const id = parseId(issueId);
  if (id === null) return { message: "That issue does not exist." };
  const parsed = parseIssueForm(formData, { requireRepository: false });
  if (!parsed.ok) return { values: parsed.values, errors: parsed.errors };

  try {
    if (!(await updateIssue(id, parsed.input, session.userId))) return { message: "That issue no longer exists." };
  } catch (err) {
    console.error("Update issue failed:", err instanceof Error ? err.message : err);
    return { values: { ...parsed.input, body: parsed.input.body ?? "", repositoryId: "" }, message: SAVE_FAILED };
  }
  redirect(`/issues/${id}`);
}
