-- Embedding store for similarity search (the P1-17 step of the work split plan: enable pgvector, create the
-- embeddings table, build an HNSW index with cosine distance). It is here because P2-17 and P2-18 cannot run
-- without it; if the owner of P1-17 writes a different definition, that one replaces this file.
--
-- Needs a PostgreSQL with the pgvector extension installed (the pgvector/pgvector:pg16 image from db/setup.md has it).
-- Safe to run more than once: every statement is IF NOT EXISTS. It never changes existing tables or data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per embedded issue, commit or pull request and model. entity_id is deliberately not a foreign key, for the
-- same reason as audit_log.entity_id: one column points at several tables. A search joins back to the real row, so
-- an embedding whose row has been deleted is simply never shown.
CREATE TABLE IF NOT EXISTS embeddings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type   TEXT        NOT NULL CHECK (entity_type IN ('issue', 'commit', 'pull_request')),
    entity_id     BIGINT      NOT NULL,
    model         TEXT        NOT NULL,                 -- vectors from different models are never compared
    content_hash  TEXT        NOT NULL,                 -- sha-256 of the embedded text, so unchanged text is not embedded again
    embedding     vector(384) NOT NULL,                 -- all-MiniLM-L6-v2 produces 384 numbers
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when it was (re)computed
    UNIQUE (entity_type, entity_id, model)
);

-- Nearest-neighbour search by cosine distance (the <=> operator).
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);

COMMIT;
