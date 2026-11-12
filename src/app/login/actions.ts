"use server";
import { redirect } from "next/navigation";
import { createSession, deleteSession } from "@/lib/session";
import { authenticate, type LoginErrorCode } from "@/lib/login";

// Server actions are public POST endpoints. Signing in needs no session; the redirect targets are fixed paths, so the
// form cannot send anyone to another site.
export async function loginAction(formData: FormData): Promise<void> {
  const result = await authenticate({ email: formData.get("email"), password: formData.get("password") });
  let error: LoginErrorCode | null = result.ok ? null : result.error;
  if (result.ok) {
    try {
      await createSession(result.session);
    } catch (err) {
      console.error("Login failed: could not create the session:", err instanceof Error ? err.message : err);
      error = "failed";
    }
  }
  redirect(error ? `/login?error=${error}` : "/");
}

export async function logoutAction(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
