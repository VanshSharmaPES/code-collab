// Outbox delivery (P2-10): claims due rows from PostgreSQL, writes each to MongoDB, marks it done.
// At-least-once: a crash between the MongoDB write and the PostgreSQL update redelivers the row, and the
// sink's write is keyed by the outbox id, so the repeat changes nothing. Pure logic with injected db/sink.
import { COLLECTIONS } from "../src/lib/mongo-config";

export const BATCH_SIZE = 50;
export const MAX_ATTEMPTS = 10;
export const MAX_ERROR_LENGTH = 300;
// After this many failures in a row the rest of the batch is left alone (MongoDB is probably down), so the
// PostgreSQL transaction is not held open while every remaining row waits for its own timeout.
export const MAX_CONSECUTIVE_FAILURES = 3;

export type OutboxRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
};
export type OutboxDb = { query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
// Must be idempotent for a given row id.
export type OutboxSink = { deliver(row: OutboxRow): Promise<void> };

// SKIP LOCKED lets several workers run side by side without delivering the same row twice at once.
export const CLAIM_SQL =
  "SELECT id::text AS id, event_type, aggregate_type, aggregate_id::text AS aggregate_id, payload, attempts, created_at " +
  "FROM outbox WHERE processed_at IS NULL AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED";
export const MARK_DONE_SQL = "UPDATE outbox SET processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1::bigint";
// Retry after 5s, 10s, 20s … capped at one hour; after maxAttempts the row is parked ('infinity') for a person to look at.
export const MARK_FAILED_SQL =
  "UPDATE outbox SET attempts = attempts + 1, last_error = $2::text, next_attempt_at = CASE WHEN attempts + 1 >= $3::int " +
  "THEN 'infinity'::timestamptz ELSE now() + make_interval(secs => LEAST(3600, 5 * power(2, attempts))) END WHERE id = $1::bigint";
export const STATUS_SQL =
  "SELECT count(*) FILTER (WHERE processed_at IS NULL AND next_attempt_at < 'infinity')::int AS pending, " +
  "count(*) FILTER (WHERE processed_at IS NULL AND next_attempt_at = 'infinity')::int AS parked, " +
  "count(*) FILTER (WHERE processed_at IS NOT NULL)::int AS delivered FROM outbox";

export type BatchResult = { claimed: number; delivered: number; failed: number; parked: number; deferred: number };

export async function processBatch(
  db: OutboxDb,
  sink: OutboxSink,
  describe: (err: unknown) => string,
  options: { batchSize?: number; maxAttempts?: number; maxConsecutiveFailures?: number } = {},
): Promise<BatchResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  const result: BatchResult = { claimed: 0, delivered: 0, failed: 0, parked: 0, deferred: 0 };
  let failuresInARow = 0;

  await db.query("BEGIN");
  try {
    const rows = (await db.query(CLAIM_SQL, [batchSize])).rows as unknown as OutboxRow[];
    result.claimed = rows.length;
    for (const row of rows) {
      if (failuresInARow >= maxConsecutiveFailures) { result.deferred++; continue; } // untouched: still pending, due again next batch
      let delivery: unknown = null;
      try {
        await sink.deliver(row);
      } catch (err) {
        delivery = err ?? new Error("delivery failed");
      }
      if (delivery === null) {
        await db.query(MARK_DONE_SQL, [row.id]);
        result.delivered++;
        failuresInARow = 0;
      } else {
        await db.query(MARK_FAILED_SQL, [row.id, describe(delivery).slice(0, MAX_ERROR_LENGTH), maxAttempts]);
        result.failed++;
        failuresInARow++;
        if (row.attempts + 1 >= maxAttempts) result.parked++;
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    // The bookkeeping itself failed: undo it. Rows already written to MongoDB are redelivered, which is safe.
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
  return result;
}

// ---- the MongoDB sink ----

type EventCollection = {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert: true },
  ): Promise<unknown>;
};
export type EventDb = { collection(name: string): EventCollection };

const DUPLICATE_KEY = 11000;

// The event document for an outbox row. Everything comes from the row; nothing is added or looked up.
export function toActivityEvent(row: OutboxRow) {
  const payload = row.payload ?? {};
  const str = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : null);
  return {
    outboxId: row.id,
    type: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    repositoryId: str("repositoryId"),
    actorId: str("actorId"),
    occurredAt: new Date(row.created_at),
    data: payload,
  };
}

export function createMongoSink(db: EventDb): OutboxSink {
  return {
    async deliver(row) {
      try {
        // $setOnInsert: a repeated delivery finds the existing event and leaves it exactly as it was.
        await db.collection(COLLECTIONS.activityEvents).updateOne({ outboxId: row.id }, { $setOnInsert: toActivityEvent(row) }, { upsert: true });
      } catch (err) {
        // Two workers upserting the same new id at once: one gets a duplicate-key error. The event exists, so it is delivered.
        if ((err as { code?: number }).code === DUPLICATE_KEY) return;
        throw err;
      }
    },
  };
}
