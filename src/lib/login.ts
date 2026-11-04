import "server-only";
import { query } from "@/lib/db";
import { parseLoginInput } from "@/lib/login-input";
import { verifyDummyPassword, verifyPassword } from "@/lib/password";
import { toSessionPayload, type SessionPayload } from "@/lib/session-token";

// Sign-in for the login page. The rules are the ones of POST /api/auth/login: the same input limits, the same generic
// answer for an unknown email and a wrong password (a dummy hash is checked so both take about as long), and the role
// comes from the database and is validated before it goes into a session.
type UserRow = { id: string; password_hash: string; role: string };

export const FIND_USER_SQL = "SELECT id, password_hash, role FROM users WHERE email = $1";

export type LoginDeps = {
  findUser(email: string): Promise<UserRow | undefined>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  verifyDummyPassword(password: string): Promise<void>;
};

const defaultDeps: LoginDeps = {
  findUser: async (email) => (await query<UserRow>(FIND_USER_SQL, [email]))[0],
  verifyPassword,
  verifyDummyPassword,
};

// The error code travels in the redirect URL, so it is only ever used as a key into this object, never shown as text.
export const LOGIN_ERRORS = {
  invalid: "Invalid email or password.",
  failed: "Signing in is not possible right now. Please try again later.",
} as const;
export type LoginErrorCode = keyof typeof LOGIN_ERRORS;

export type LoginResult = { ok: true; session: SessionPayload } | { ok: false; error: LoginErrorCode };

export async function authenticate(raw: { email: unknown; password: unknown }, deps: LoginDeps = defaultDeps): Promise<LoginResult> {
  const input = parseLoginInput(raw);
  if (input === null) return { ok: false, error: "invalid" };
  try {
    const user = await deps.findUser(input.email);
    if (!user) {
      await deps.verifyDummyPassword(input.password);
      return { ok: false, error: "invalid" };
    }
    if (!(await deps.verifyPassword(user.password_hash, input.password))) return { ok: false, error: "invalid" };
    const session = toSessionPayload(user.id, user.role);
    if (!session) {
      console.error("Login refused: users row has an unexpected id or role value.");
      return { ok: false, error: "failed" };
    }
    return { ok: true, session };
  } catch (err) {
    console.error("Login failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "failed" };
  }
}
