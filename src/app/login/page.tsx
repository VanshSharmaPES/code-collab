import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LOGIN_ERRORS } from "@/lib/login";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Sign in | CodeCollab" };

const FIELD = "rounded border border-zinc-400 bg-transparent px-3 py-2 text-sm";

function LoginForm({ message }: { message: string | null }) {
  return (
    <form action={loginAction} className="flex flex-col gap-4">
      {message && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{message}</p>}
      <label className="flex flex-col gap-1 text-sm font-medium">
        Email
        <input name="email" type="email" required autoFocus autoComplete="username" maxLength={254} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Password
        <input name="password" type="password" required autoComplete="current-password" maxLength={128} className={FIELD} />
      </label>
      <button type="submit" className="rounded border border-zinc-400 px-3 py-2 text-sm font-medium">Sign in</button>
    </form>
  );
}

// The session cookie and the ?error= code are read at request time, so they sit behind a Suspense boundary. The
// fallback is the same form without a message, so nothing flashes. The code is only a key into LOGIN_ERRORS, never shown.
async function LoginFormWithMessage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await getSession()) !== null) redirect("/");
  const { error } = await searchParams;
  const message = typeof error === "string" && Object.hasOwn(LOGIN_ERRORS, error) ? LOGIN_ERRORS[error as keyof typeof LOGIN_ERRORS] : null;
  return <LoginForm message={message} />;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to CodeCollab</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Mentors, team leads and students all sign in here.</p>
      </div>
      <Suspense fallback={<LoginForm message={null} />}>
        <LoginFormWithMessage searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
