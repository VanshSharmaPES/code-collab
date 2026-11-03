import { connection } from "next/server";
import { noStoreJson } from "@/lib/auth-response";
import { deleteSession } from "@/lib/session";

export async function POST() {
  await connection();
  try {
    await deleteSession();
    return noStoreJson({ ok: true });
  } catch (err) {
    console.error("Logout failed:", err instanceof Error ? err.message : err);
    return noStoreJson({ error: "Internal server error" }, 500);
  }
}
