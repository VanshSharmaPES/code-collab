import { connection } from "next/server";
import { noStoreJson } from "@/lib/auth-response";
import { query } from "@/lib/db";
import { parseLoginInput } from "@/lib/login-input";
import { verifyDummyPassword, verifyPassword } from "@/lib/password";
import { isJsonContentType, readLimitedBody } from "@/lib/request-body";
import { createSession } from "@/lib/session";
import { getSessionKey, toSessionPayload } from "@/lib/session-token";

const MAX_BODY_BYTES = 4096;

type UserRow = { id: string; email: string; full_name: string; password_hash: string; role: string };

export async function POST(request: Request) {
  await connection();

  // Fail before touching credentials if sessions cannot be signed safely.
  try {
    getSessionKey(process.env.SESSION_SECRET);
  } catch (err) {
    console.error("Login unavailable:", err instanceof Error ? err.message : err);
    return noStoreJson({ error: "Internal server error" }, 500);
  }

  // Requiring JSON means a cross-site HTML form cannot submit to this route.
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return noStoreJson({ error: "Content-Type must be application/json" }, 415);
  }

  // The size limit is enforced while reading, not after buffering the whole body.
  let body;
  try {
    body = await readLimitedBody(request, MAX_BODY_BYTES);
  } catch {
    return noStoreJson({ error: "Invalid request" }, 400);
  }
  if (!body.ok) {
    return noStoreJson({ error: "Request too large" }, 413);
  }

  let input;
  try {
    input = parseLoginInput(JSON.parse(body.text));
  } catch {
    input = null;
  }
  if (!input) {
    return noStoreJson({ error: "Invalid request" }, 400);
  }

  try {
    const rows = await query<UserRow>(
      "SELECT id, email, full_name, password_hash, role FROM users WHERE email = $1",
      [input.email],
    );
    const user = rows[0];

    // Same generic response for unknown email and wrong password.
    if (!user) {
      await verifyDummyPassword(input.password);
      return noStoreJson({ error: "Invalid email or password" }, 401);
    }
    if (!(await verifyPassword(user.password_hash, input.password))) {
      return noStoreJson({ error: "Invalid email or password" }, 401);
    }

    // The role comes from the database, so check it before it goes into a session.
    const session = toSessionPayload(user.id, user.role);
    if (!session) {
      console.error("Login refused: users row has an unexpected id or role value.");
      return noStoreJson({ error: "Internal server error" }, 500);
    }

    await createSession(session);
    return noStoreJson({
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error("Login failed:", err instanceof Error ? err.message : err);
    return noStoreJson({ error: "Internal server error" }, 500);
  }
}
