import "server-only";
import { Pool, type QueryResultRow } from "pg";

// Cache the pool on globalThis so dev hot reloads reuse one pool.
const globalForPg = globalThis as unknown as { pgPool?: Pool };

// Created lazily so builds and imports do not require DATABASE_URL.
export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    }
    const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
    // Idle clients can error (e.g. server restart); log without crashing the process.
    pool.on("error", (err) => console.error("Unexpected PostgreSQL pool error:", err.message));
    globalForPg.pgPool = pool;
  }
  return globalForPg.pgPool;
}

// Always pass user-supplied values through `params`, never by string interpolation.
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, [...params]);
  return result.rows;
}

export type TxRun = <T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) => Promise<T[]>;

// Runs `fn` on one pooled connection inside BEGIN ... COMMIT (ROLLBACK if it throws), so SET LOCAL settings apply to
// exactly the statements `fn` runs and never leak to another request.
export async function withTransaction<R>(fn: (run: TxRun) => Promise<R>): Promise<R> {
  const client = await getPool().connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const out = await fn(async <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => (await client.query<T>(text, [...params])).rows);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { broken = true; } // a connection that cannot roll back is discarded, not reused
    throw err;
  } finally {
    client.release(broken);
  }
}
