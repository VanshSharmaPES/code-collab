import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  getSessionKey,
  readSession,
  requireSessionOr,
  sessionCookieOptions,
  signSession,
  type SessionPayload,
} from "@/lib/session-token";

export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await signSession(payload, getSessionKey(process.env.SESSION_SECRET));
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(process.env.NODE_ENV === "production"));
}

export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  return readSession(token, process.env.SESSION_SECRET);
}

// There is no login page yet, so visitors without a session go back to the home page.
// Change this one constant when a login page exists.
export const UNAUTHENTICATED_REDIRECT = "/";

// For server components: ends rendering with a redirect when there is no valid session.
export async function requireSession(): Promise<SessionPayload> {
  return requireSessionOr(await getSession(), () => redirect(UNAUTHENTICATED_REDIRECT));
}

export async function deleteSession(): Promise<void> {
  (await cookies()).delete({ name: SESSION_COOKIE_NAME, path: SESSION_COOKIE_PATH });
}
