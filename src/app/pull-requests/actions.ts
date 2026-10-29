"use server";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { parsePullRequestAction, type ActionErrorCode } from "@/lib/pull-request-input";
import { PullRequestMirroredError, PullRequestNotFoundError, PullRequestRuleError, PullRequestStatusError, transitionPullRequest } from "@/lib/pull-requests";

// Server actions are public POST endpoints, so this one checks the session itself.
export async function transitionPullRequestAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const rawId = formData.get("id");
  const id = typeof rawId === "string" ? parseId(rawId) : null;
  const action = parsePullRequestAction(formData.get("action"));
  if (id === null || action === null) redirect("/pull-requests");

  let error: ActionErrorCode | null = null;
  try {
    await transitionPullRequest(id, action, session.userId);
  } catch (err) {
    if (err instanceof PullRequestNotFoundError) redirect("/pull-requests");
    if (err instanceof PullRequestMirroredError) error = "mirrored";
    else if (err instanceof PullRequestStatusError) error = "status";
    else if (err instanceof PullRequestRuleError) {
      error = err.code;
      if (err.code === "mergeRefused") console.error("Merge refused:", err.detail); // an unrecognised procedure message
    }
    else {
      console.error("Pull request update failed:", err instanceof Error ? err.message : err);
      error = "failed";
    }
  }
  redirect(error ? `/pull-requests/${id}?error=${error}` : `/pull-requests/${id}`);
}
