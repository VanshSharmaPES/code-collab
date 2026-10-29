import { Suspense } from "react";
import { COMMENT_ERRORS, MAX_COMMENT_LENGTH, MAX_REPLY_DEPTH, type CommentTarget } from "@/lib/comment-input";
import { listComments, type CommentNode } from "@/lib/comments";
import { commentDeps } from "@/lib/comments-server";
import { formatDate } from "@/lib/format";
import { addCommentAction } from "./actions";

// The error code comes from the URL, so it is only used as a key into COMMENT_ERRORS, never shown as text.
export function commentErrorMessage(code: string | string[] | undefined): string | null {
  return typeof code === "string" && Object.hasOwn(COMMENT_ERRORS, code) ? COMMENT_ERRORS[code as keyof typeof COMMENT_ERRORS] : null;
}

type FormProps = { targetType: CommentTarget; targetId: string; parentId?: string; label: string };

function CommentForm({ targetType, targetId, parentId, label }: FormProps) {
  return (
    <form action={addCommentAction} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      <label className="text-sm font-medium" htmlFor={`body-${parentId ?? "new"}`}>{label}</label>
      <textarea id={`body-${parentId ?? "new"}`} name="body" required maxLength={MAX_COMMENT_LENGTH} rows={3} className="rounded border border-zinc-400 bg-transparent p-2 text-sm" />
      <button type="submit" className="self-start rounded border border-zinc-400 px-3 py-1 text-sm">Post</button>
    </form>
  );
}

function Comment({ node, targetType, targetId }: { node: CommentNode; targetType: CommentTarget; targetId: string }) {
  return (
    <li className="mt-3">
      <div className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800">
        <p className="text-xs text-zinc-600 dark:text-zinc-400"><span className="font-medium">{node.authorName}</span> · {formatDate(node.createdAt)}</p>
        {/* Plain text: React escapes it, and whitespace-pre-wrap keeps the line breaks. */}
        <p className="mt-1 whitespace-pre-wrap break-words">{node.body}</p>
        {node.depth < MAX_REPLY_DEPTH && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs underline">Reply</summary>
            <CommentForm targetType={targetType} targetId={targetId} parentId={node.id} label="Your reply" />
          </details>
        )}
      </div>
      {node.replies.length > 0 && (
        <ul className="ml-4 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          {node.replies.map((r) => <Comment key={r.id} node={r} targetType={targetType} targetId={targetId} />)}
        </ul>
      )}
    </li>
  );
}

type ThreadProps = { targetType: CommentTarget; targetId: string; viewerId: string; error: string | null };

// The comments load behind their own Suspense boundary, so the issue or pull request details are sent right away
// and a slow or unreachable MongoDB (server selection can take seconds) only delays this section.
export function CommentThread(props: ThreadProps) {
  return (
    <Suspense fallback={<section id="comments" className="mt-8"><h2 className="text-lg font-semibold">Comments</h2><p role="status" className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Loading comments…</p></section>}>
      <CommentThreadContent {...props} />
    </Suspense>
  );
}

// Fails on its own: a MongoDB outage shows a message here and leaves the rest of the page alone.
async function CommentThreadContent({ targetType, targetId, viewerId, error }: ThreadProps) {
  let thread: CommentNode[] | null = null;
  let failed = false;
  try {
    thread = await listComments(targetType, targetId, viewerId, commentDeps);
  } catch (err) {
    failed = true;
    console.error("Comments: could not load the thread:", err instanceof Error ? err.message : err);
  }
  return (
    <section id="comments" className="mt-8">
      <h2 className="text-lg font-semibold">Comments</h2>
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {failed ? (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">Comments could not be loaded right now. Please try again later.</p>
      ) : (
        <>
          {thread === null || thread.length === 0 ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No comments yet.</p> : (
            <ul>{thread.map((n) => <Comment key={n.id} node={n} targetType={targetType} targetId={targetId} />)}</ul>
          )}
          <div className="mt-4"><CommentForm targetType={targetType} targetId={targetId} label="Add a comment" /></div>
        </>
      )}
    </section>
  );
}
