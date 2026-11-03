"use server";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { parseId } from "@/lib/issue-input";
import { parseCommentTarget } from "@/lib/comment-input";
import { addComment } from "@/lib/comments";
import { commentDeps } from "@/lib/comments-server";

const PAGES = { issue: "/issues", pull_request: "/pull-requests" } as const;

// Server actions are public POST endpoints, so this one checks the session itself. The target comes from the form,
// so addComment checks the viewer's access to it again; nothing here trusts the page that rendered the form.
export async function addCommentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const targetType = parseCommentTarget(formData.get("targetType"));
  const rawId = formData.get("targetId");
  const targetId = typeof rawId === "string" ? parseId(rawId) : null;
  if (targetType === null || targetId === null) redirect("/");

  let error: string | null = null;
  try {
    const result = await addComment({ targetType, targetId, parentId: formData.get("parentId"), body: formData.get("body") }, session.userId, commentDeps);
    if (!result.ok) {
      if (result.error === "notFound") redirect(PAGES[targetType]);
      error = result.error;
    }
  } catch (err) {
    // redirect() throws; let it through.
    if (err instanceof Error && "digest" in err) throw err;
    console.error("Add comment failed:", err instanceof Error ? err.message : err);
    error = "failed";
  }
  redirect(error ? `${PAGES[targetType]}/${targetId}?commentError=${error}#comments` : `${PAGES[targetType]}/${targetId}#comments`);
}
