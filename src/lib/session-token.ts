import "server-only";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_COOKIE_NAME = "cc_session";
// Used when setting AND deleting the cookie: a delete only works on the same path.
export const SESSION_COOKIE_PATH = "/";
const MIN_SECRET_LENGTH = 32;
const ROLES = ["student", "lead", "mentor"] as const;

export type SessionRole = (typeof ROLES)[number];
export type SessionPayload = { userId: string; role: SessionRole };

export function isSessionRole(value: unknown): value is SessionRole {
  return ROLES.some((r) => r === value);
}

// Builds a payload from untrusted database values; null if either is unusable.
export function toSessionPayload(userId: unknown, role: unknown): SessionPayload | null {
  if (typeof userId !== "string" || userId.length === 0 || !isSessionRole(role)) return null;
  return { userId, role };
}

// Returns the session, or calls `deny` (e.g. a redirect, which never returns) when absent.
export function requireSessionOr(session: SessionPayload | null, deny: () => never): SessionPayload {
  return session ?? deny();
}

// Throws a message that never contains the secret itself. The secret is passed in
// explicitly (callers use process.env.SESSION_SECRET) so nothing is read implicitly.
export function getSessionKey(secret: string | undefined): Uint8Array {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.`);
  }
  return new TextEncoder().encode(secret);
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: SESSION_COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export async function signSession(payload: SessionPayload, key: Uint8Array): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(key);
}

// Returns null for any invalid, tampered or expired token.
export async function verifySession(token: string, key: Uint8Array): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return toSessionPayload(payload.sub, payload.role);
  } catch {
    return null;
  }
}

// Fails closed: no cookie means no session (the secret is not needed); a cookie with a
// missing or too-short secret is a server misconfiguration, so it is logged without any
// values and treated as "not signed in", never as a valid session.
export async function readSession(token: string | undefined, secret: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  let key: Uint8Array;
  try {
    key = getSessionKey(secret);
  } catch (err) {
    console.error("Session check failed:", err instanceof Error ? err.message : "invalid session configuration");
    return null;
  }
  return verifySession(token, key);
}
