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
