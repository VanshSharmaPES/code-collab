// The steps of the embedding pipeline (P2-17), kept apart from the runner so they can be tested without the model.
// It reads issues, commits and pull requests that have no embedding yet (or changed since), embeds their text and
// stores the vectors in the embeddings table. Safe to stop and rerun: finished rows are skipped.
import { createHash } from "node:crypto";
import { DIMENSIONS, MODEL_NAME, toVectorLiteral, type Embedder } from "../src/lib/embedding-model";

export const KINDS = ["issue", "commit", "pull_request"] as const;
export type Kind = (typeof KINDS)[number];

export const BATCH_SIZE = 32;
// The model reads roughly the first 256 word pieces, so more text only costs time.
export const MAX_TEXT_CHARS = 1500;

export type EmbedDb = { query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

// $1 model, $2 last id handled (keyset paging), $3 batch size. "Pending" means no embedding for this model yet, or (for
// rows that can change) edited after the embedding was computed. Commits never change, so only the first applies.
const pendingSql = (select: string, from: string, alias: string, kind: Kind, changes: boolean) =>
  `SELECT ${alias}.id::text AS id, ${select}, e.content_hash AS stored_hash FROM ${from} ` +
  `LEFT JOIN embeddings e ON e.entity_type = '${kind}' AND e.entity_id = ${alias}.id AND e.model = $1 ` +
  `WHERE ${alias}.id > $2::bigint AND (e.id IS NULL${changes ? ` OR ${alias}.updated_at > e.created_at` : ""}) ORDER BY ${alias}.id LIMIT $3`;

export const PENDING_SQL: Record<Kind, string> = {
  issue: pendingSql("i.title AS first, i.body AS second", "issues i", "i", "issue", true),
  commit: pendingSql("c.message AS first, NULL::text AS second", "commits c", "c", "commit", false),
  pull_request: pendingSql("p.title AS first, p.description AS second", "pull_requests p", "p", "pull_request", true),
};

const countSql = (from: string, alias: string, kind: Kind, changes: boolean) =>
  `SELECT count(*)::int AS n FROM ${from} LEFT JOIN embeddings e ON e.entity_type = '${kind}' AND e.entity_id = ${alias}.id AND e.model = $1 ` +
  `WHERE e.id IS NULL${changes ? ` OR ${alias}.updated_at > e.created_at` : ""}`;

export const COUNT_PENDING_SQL: Record<Kind, string> = {
  issue: countSql("issues i", "i", "issue", true),
  commit: countSql("commits c", "c", "commit", false),
  pull_request: countSql("pull_requests p", "p", "pull_request", true),
};

// $1 type, $2 id, $3 model, $4 hash, $5 vector text. The unique key makes a rerun update the row instead of adding one.
export const UPSERT_SQL =
  "INSERT INTO embeddings (entity_type, entity_id, model, content_hash, embedding) VALUES ($1::text, $2::bigint, $3::text, $4::text, $5::vector) " +
  "ON CONFLICT (entity_type, entity_id, model) DO UPDATE SET content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding, created_at = now()";
// The text was edited in a way that does not change what is embedded (for example only the status): keep the vector.
export const TOUCH_SQL = "UPDATE embeddings SET created_at = now() WHERE entity_type = $1::text AND entity_id = $2::bigint AND model = $3::text";
export const TABLE_EXISTS_SQL = "SELECT to_regclass('public.embeddings') IS NOT NULL AS ok";

// What gets embedded: the title (or commit message) and the description, on one line, control characters removed, cut to size.
export function textFor(first: unknown, second: unknown): string {
  const joined = [first, second].filter((x): x is string => typeof x === "string").join("\n");
  const printable = Array.from(joined, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export type KindResult = { seen: number; embedded: number; unchanged: number; empty: number };

export async function countPending(db: EmbedDb, kind: Kind, model: string = MODEL_NAME): Promise<number> {
  const n = (await db.query(COUNT_PENDING_SQL[kind], [model])).rows[0]?.n;
  return typeof n === "number" ? n : 0;
}

type Options = { limit: number; batchSize?: number; model?: string; log?: (line: string) => void };

// Embeds up to `limit` pending rows of one kind. Each vector is checked (384 finite numbers) before it is written.
export async function embedKind(db: EmbedDb, kind: Kind, embedder: Embedder, options: Options): Promise<KindResult> {
  const model = options.model ?? MODEL_NAME;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const result: KindResult = { seen: 0, embedded: 0, unchanged: 0, empty: 0 };
  let cursor = "0";
  while (result.seen < options.limit) {
    const rows = (await db.query(PENDING_SQL[kind], [model, cursor, Math.min(batchSize, options.limit - result.seen)])).rows;
    if (rows.length === 0) break;
    cursor = String(rows[rows.length - 1].id);
    result.seen += rows.length;

    const fresh: { id: string; text: string; hash: string }[] = [];
    for (const row of rows) {
      const text = textFor(row.first, row.second);
      const id = String(row.id);
      if (text === "") { result.empty++; continue; }
      const hash = contentHash(text);
      if (row.stored_hash === hash) { await db.query(TOUCH_SQL, [kind, id, model]); result.unchanged++; continue; }
      fresh.push({ id, text, hash });
    }
    if (fresh.length > 0) {
      const vectors = await embedder(fresh.map((f) => f.text));
      if (vectors.length !== fresh.length) throw new Error(`The embedder returned ${vectors.length} vectors for ${fresh.length} texts.`);
      for (let i = 0; i < fresh.length; i++) {
        await db.query(UPSERT_SQL, [kind, fresh[i].id, model, fresh[i].hash, toVectorLiteral(vectors[i])]);
        result.embedded++;
      }
    }
    options.log?.(`  ${kind}: ${result.seen} read, ${result.embedded} embedded, ${result.unchanged} unchanged${result.empty ? `, ${result.empty} empty` : ""}`);
  }
  return result;
}

// ---- command line ----

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1_000_000;
const KIND_NAMES: Record<string, readonly Kind[]> = { issues: ["issue"], commits: ["commit"], "pull-requests": ["pull_request"], all: KINDS };

export function parseEmbedArgs(argv: readonly string[]) {
  let apply = false, kinds: readonly Kind[] = KINDS, limit = DEFAULT_LIMIT;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--kind=") && Object.hasOwn(KIND_NAMES, arg.slice(7))) kinds = KIND_NAMES[arg.slice(7)];
    else if (/^--limit=[1-9]\d{0,6}$/.test(arg) && Number(arg.slice(8)) <= MAX_LIMIT) limit = Number(arg.slice(8));
    else throw new Error(`Unsupported or invalid argument: ${arg}. Supported: --apply, --kind=issues|commits|pull-requests|all, --limit=1..${MAX_LIMIT}.`);
  }
  return { apply, kinds, limit };
}

export { DIMENSIONS, MODEL_NAME };
