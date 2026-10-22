// Pure request-body validation for login; no I/O so it is easy to test.
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

export type LoginInput = { email: string; password: string };

// The email is trimmed and lowercased (the users table stores lowercase emails).
// The password is passed through exactly as sent: no trimming or other changes.
export function parseLoginInput(body: unknown): LoginInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") return null;

  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length === 0 || normalizedEmail.length > MAX_EMAIL_LENGTH) return null;
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return null;
  return { email: normalizedEmail, password };
}
