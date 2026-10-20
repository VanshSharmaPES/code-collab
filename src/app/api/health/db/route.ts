import { connection } from "next/server";
import { query } from "@/lib/db";

export async function GET() {
  // Opt out of build-time prerendering: this must only run on a real request.
  await connection();
  try {
    await query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch (err) {
    // Details stay in the server log; the response reveals nothing about the database.
    console.error("Database health check failed:", err instanceof Error ? err.message : err);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
