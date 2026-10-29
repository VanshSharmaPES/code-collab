-- CodeCollab transactional outbox (P2-10). Depends on 01_core.sql and 02_rest.sql.
-- Safe to run more than once: the table and index are created only if missing, the function is replaced, and the two
-- triggers are recreated (they are the only objects this file drops, and it created them).
--
-- Flow: a status change on an issue or pull request fires a trigger that inserts one outbox row IN THE SAME
-- TRANSACTION as the change, so both commit or both roll back. The background worker (scripts/outbox-worker.ts)
-- later delivers each row to MongoDB (collection activity_events), keyed by the row id so a repeat changes nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS outbox (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type      TEXT        NOT NULL,                 -- e.g. pull_request.status_changed
    aggregate_type  TEXT        NOT NULL,                 -- issue | pull_request
    aggregate_id    BIGINT      NOT NULL,                 -- id of the changed row; no FK, the event outlives it
    payload         JSONB       NOT NULL,                 -- what MongoDB stores; never emails or password data
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 'infinity' parks a row after too many failures
    last_error      TEXT,
    processed_at    TIMESTAMPTZ
);

-- The worker's only query: unprocessed rows that are due, oldest first.
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (next_attempt_at, id) WHERE processed_at IS NULL;

-- One generic function serves both tables; the aggregate type is the trigger argument. It sits next to the audit
-- trigger of P1-10 (04_triggers.sql) and reads the same transaction-local setting for the actor. Unlike the audit
-- trigger it does NOT stay quiet while merge_pull_request runs: the merge and the issues it closes are real status
-- changes and belong in the activity stream.
-- Payload keys are the event contract of the worker (scripts/outbox-data.ts): repositoryId and actorId are strings
-- (actorId is null when the writer did not set codecollab.actor_id).
CREATE OR REPLACE FUNCTION outbox_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO outbox (event_type, aggregate_type, aggregate_id, payload)
    VALUES (TG_ARGV[0] || '.status_changed', TG_ARGV[0], NEW.id,
            jsonb_build_object(
                'repositoryId', NEW.repository_id::text,
                'actorId',      nullif(current_setting('codecollab.actor_id', true), ''),
                'number',       NEW.number,
                'title',        NEW.title,
                'oldStatus',    OLD.status,
                'newStatus',    NEW.status));
    RETURN NULL;   -- AFTER trigger: the return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_pull_requests_status_outbox ON pull_requests;
CREATE TRIGGER trg_pull_requests_status_outbox
    AFTER UPDATE OF status ON pull_requests
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION outbox_status_change('pull_request');

DROP TRIGGER IF EXISTS trg_issues_status_outbox ON issues;
CREATE TRIGGER trg_issues_status_outbox
    AFTER UPDATE OF status ON issues
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION outbox_status_change('issue');

COMMIT;
