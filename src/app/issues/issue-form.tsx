"use client";
import Link from "next/link";
import { useActionState } from "react";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, MAX_BODY_LENGTH, MAX_TITLE_LENGTH, type IssueFormState } from "@/lib/issue-input";

type Props = {
  action: (prev: IssueFormState, formData: FormData) => Promise<IssueFormState>;
  repositories?: { id: string; name: string; projectName: string }[]; // present only when creating
  initial: { title: string; body: string; status: string; priority: string; repositoryId: string };
  submitLabel: string;
  cancelHref: string;
};

const inputClass = "mt-1 w-full rounded border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
const errorClass = "mt-1 text-sm text-red-700 dark:text-red-400";

export function IssueForm({ action, repositories, initial, submitLabel, cancelHref }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as IssueFormState);
  const v = state.values ?? initial;
  const e = state.errors ?? {};
  // Remount the inputs when the server returns the submitted values, so they show what was typed.
  const key = state.values ? "submitted" : "initial";

  return (
    <form action={formAction} key={key} className="mt-6 flex max-w-2xl flex-col gap-4" noValidate>
      {state.message && <p role="alert" className="text-red-700 dark:text-red-400">{state.message}</p>}

      {repositories && (
        <label className="block text-sm font-medium">
          Repository
          <select name="repositoryId" defaultValue={v.repositoryId} required aria-invalid={!!e.repositoryId} className={inputClass}>
            <option value="" disabled>Choose a repository…</option>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>{r.projectName} / {r.name}</option>
            ))}
          </select>
          {e.repositoryId && <span role="alert" className={errorClass}>{e.repositoryId}</span>}
        </label>
      )}

      <label className="block text-sm font-medium">
        Title
        <input name="title" defaultValue={v.title} maxLength={MAX_TITLE_LENGTH} required aria-invalid={!!e.title} className={inputClass} />
        {e.title && <span role="alert" className={errorClass}>{e.title}</span>}
      </label>

      <label className="block text-sm font-medium">
        Description
        <textarea name="body" defaultValue={v.body} rows={8} maxLength={MAX_BODY_LENGTH} aria-invalid={!!e.body} className={inputClass} />
        {e.body && <span role="alert" className={errorClass}>{e.body}</span>}
      </label>

      <div className="flex gap-4">
        <label className="block flex-1 text-sm font-medium">
          Status
          <select name="status" defaultValue={v.status} className={inputClass}>
            {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
          {e.status && <span role="alert" className={errorClass}>{e.status}</span>}
        </label>
        <label className="block flex-1 text-sm font-medium">
          Priority
          <select name="priority" defaultValue={v.priority} className={inputClass}>
            {ISSUE_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {e.priority && <span role="alert" className={errorClass}>{e.priority}</span>}
        </label>
      </div>

      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900">
          {pending ? "Saving…" : submitLabel}
        </button>
        <Link href={cancelHref} className="text-sm underline">Cancel</Link>
      </div>
    </form>
  );
}
