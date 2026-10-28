import "server-only";
import { query } from "@/lib/db";
import { MODEL_NAME, toVectorLiteral } from "@/lib/embedding-model";

type RunQuery<T> = (text: string, params: readonly unknown[]) => Promise<T[]>;

export const SEARCH_LIMIT = 10;
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 200;

export type SearchKind = "issue" | "pull_request" | "commit";
export type SearchHit = { kind: SearchKind; id: string; number: number | null; title: string; repository_name: string; score: number };

// The search text from the query string: one string, no control characters, spaces collapsed, 2 to 200 characters.
// Anything else is null. It is only ever passed to the database as a parameter.
export function parseSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = Array.from(raw, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return cleaned.length >= MIN_QUERY_LENGTH && cleaned.length <= MAX_QUERY_LENGTH ? cleaned : null;
}

const FIRST_LINE = (column: string) => `left(split_part(${column}, E'\\n', 1), 140)`;

// Keyword search: PostgreSQL full-text search over the same text that is embedded. websearch_to_tsquery accepts any
// user text (quotes, minus, "or") without ever raising a syntax error. $1 the text, $2 the number of results.
export const KEYWORD_SEARCH_SQL =
  "WITH q AS (SELECT websearch_to_tsquery('english', $1::text) AS tsq) SELECT kind, id, number, title, repository_name, score FROM (" +
  "SELECT 'issue' AS kind, i.id::text AS id, i.number, i.title, r.name AS repository_name, ts_rank(v.doc, q.tsq)::float8 AS score " +
  "FROM issues i JOIN repositories r ON r.id = i.repository_id, q, LATERAL (SELECT to_tsvector('english', i.title || ' ' || coalesce(i.body, '')) AS doc) v WHERE v.doc @@ q.tsq " +
  "UNION ALL " +
  "SELECT 'pull_request', p.id::text, p.number, p.title, r.name, ts_rank(v.doc, q.tsq)::float8 " +
  "FROM pull_requests p JOIN repositories r ON r.id = p.repository_id, q, LATERAL (SELECT to_tsvector('english', p.title || ' ' || coalesce(p.description, '')) AS doc) v WHERE v.doc @@ q.tsq " +
  "UNION ALL " +
  `SELECT 'commit', c.id::text, NULL::int, ${FIRST_LINE("c.message")}, r.name, ts_rank(v.doc, q.tsq)::float8 ` +
  "FROM commits c JOIN repositories r ON r.id = c.repository_id, q, LATERAL (SELECT to_tsvector('english', c.message) AS doc) v WHERE v.doc @@ q.tsq" +
  ") hits ORDER BY score DESC, kind, id::bigint LIMIT $2";

// Semantic search: the nearest stored vectors by cosine distance (served by the HNSW index), joined back to the real
// row. An embedding whose row no longer exists is dropped. $1 the query vector as text, $2 the model, $3 the number of results.
// score is the cosine similarity, 1 for the same direction.
export const SEMANTIC_SEARCH_SQL =
  "WITH nn AS (SELECT e.entity_type, e.entity_id, e.embedding <=> $1::vector AS distance FROM embeddings e WHERE e.model = $2::text " +
  "ORDER BY e.embedding <=> $1::vector LIMIT $3) " +
  "SELECT nn.entity_type AS kind, nn.entity_id::text AS id, coalesce(i.number, p.number) AS number, " +
  `coalesce(i.title, p.title, ${FIRST_LINE("c.message")}) AS title, coalesce(ri.name, rp.name, rc.name) AS repository_name, (1 - nn.distance)::float8 AS score ` +
  "FROM nn " +
  "LEFT JOIN issues i ON nn.entity_type = 'issue' AND i.id = nn.entity_id LEFT JOIN repositories ri ON ri.id = i.repository_id " +
  "LEFT JOIN pull_requests p ON nn.entity_type = 'pull_request' AND p.id = nn.entity_id LEFT JOIN repositories rp ON rp.id = p.repository_id " +
  "LEFT JOIN commits c ON nn.entity_type = 'commit' AND c.id = nn.entity_id LEFT JOIN repositories rc ON rc.id = c.repository_id " +
  "WHERE coalesce(i.id, p.id, c.id) IS NOT NULL ORDER BY nn.distance, nn.entity_type, nn.entity_id";

export async function searchKeyword(text: string, run: RunQuery<SearchHit> = query<SearchHit>): Promise<SearchHit[]> {
  return run(KEYWORD_SEARCH_SQL, [text, SEARCH_LIMIT]);
}

export async function searchSemantic(vector: readonly number[], run: RunQuery<SearchHit> = query<SearchHit>): Promise<SearchHit[]> {
  return run(SEMANTIC_SEARCH_SQL, [toVectorLiteral(vector), MODEL_NAME, SEARCH_LIMIT]);
}
