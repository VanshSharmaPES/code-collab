-- P2-10 demo: the outbox row is written in the same transaction as the status change.
-- Needs 01-04 and 07 in db/schema plus the synthetic seed. Everything runs in one transaction that ends in
-- ROLLBACK, so nothing is kept. Every check prints a column named *_ok that must be true.
\set ON_ERROR_STOP off
\pset pager off
BEGIN;

SELECT p.id AS pr, p.author_id AS author, t.lead_id AS actor
FROM pull_requests p
JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'open' AND p.author_id IS NOT NULL ORDER BY p.id LIMIT 1 \gset
SELECT id AS iss FROM issues WHERE status = 'open' ORDER BY id LIMIT 1 \gset
SELECT count(*) AS outbox_before FROM outbox \gset

\echo '=== A. a status change writes exactly one outbox row, with the actor'
SELECT set_config('codecollab.actor_id', :'actor', true) \gset x_
UPDATE pull_requests SET status = 'closed', updated_at = now() WHERE id = :pr;
SELECT event_type, aggregate_type, aggregate_id = :pr AS aggregate_ok,
       payload->>'actorId' = :'actor' AS actor_ok, payload->>'oldStatus' AS old, payload->>'newStatus' AS new,
       payload->>'repositoryId' ~ '^[0-9]+$' AS repository_ok, processed_at IS NULL AS pending_ok
FROM outbox WHERE aggregate_id = :pr AND aggregate_type = 'pull_request';

\echo '=== B. no event for: a title-only update, the same status again, or a plain insert'
UPDATE pull_requests SET title = title || '!' WHERE id = :pr;
UPDATE pull_requests SET status = 'closed' WHERE id = :pr;
SELECT count(*) - :outbox_before = 1 AS still_one_event_ok FROM outbox;

\echo '=== C. an issue status change is captured too, and a missing actor becomes null'
SELECT set_config('codecollab.actor_id', '', true) \gset x_
UPDATE issues SET status = 'in_progress', updated_at = now() WHERE id = :iss AND status = 'open';
SELECT event_type, payload->'actorId' = 'null'::jsonb AS null_actor_ok FROM outbox WHERE aggregate_type = 'issue' AND aggregate_id = :iss;
ROLLBACK;

\echo '=== D. ROLLBACK: the change and its event disappear together'
BEGIN;
SELECT p.id AS pr2 FROM pull_requests p WHERE p.status = 'open' ORDER BY p.id LIMIT 1 \gset
SELECT count(*) AS n0 FROM outbox \gset
UPDATE pull_requests SET status = 'closed' WHERE id = :pr2;
SELECT count(*) - :n0 = 1 AS event_inside_txn_ok FROM outbox;
ROLLBACK;
SELECT (SELECT status FROM pull_requests WHERE id = :pr2) = 'open' AS status_restored_ok,
       (SELECT count(*) FROM outbox WHERE aggregate_id = :pr2 AND aggregate_type = 'pull_request') = 0 AS no_event_left_ok;

\echo '=== E. a failing statement after the change leaves no event (one transaction, one outcome)'
BEGIN;
SELECT p.id AS pr3 FROM pull_requests p WHERE p.status = 'open' ORDER BY p.id LIMIT 1 \gset
UPDATE pull_requests SET status = 'closed' WHERE id = :pr3;
UPDATE pull_requests SET status = 'not-a-status' WHERE id = :pr3;   -- violates the CHECK: the transaction is now aborted
ROLLBACK;
SELECT (SELECT count(*) FROM outbox WHERE aggregate_id = :pr3 AND aggregate_type = 'pull_request') = 0 AS no_event_left_ok;

\echo '=== F. merge_pull_request: the merge and the issues it closes are captured; a forced failure captures nothing'
BEGIN;
SELECT p.id AS mpr, t.lead_id AS merger
FROM pull_requests p
JOIN repositories r ON r.id = p.repository_id AND r.is_synthetic
JOIN projects pj ON pj.id = r.project_id AND pj.status = 'active'
JOIN teams t ON t.project_id = r.project_id
WHERE p.status = 'approved'
  AND EXISTS (SELECT 1 FROM pr_issue_links l JOIN issues i ON i.id = l.issue_id WHERE l.pull_request_id = p.id AND i.status <> 'closed')
ORDER BY p.id LIMIT 1 \gset
SELECT count(*) AS m0, coalesce(max(id), 0) AS m0_max FROM outbox \gset
SAVEPOINT s1;
CALL merge_pull_request(:mpr, :merger, TRUE);
ROLLBACK TO s1;
SELECT count(*) = :m0 AS forced_failure_no_events_ok FROM outbox;
CALL merge_pull_request(:mpr, :merger);
SELECT count(*) FILTER (WHERE aggregate_type = 'pull_request' AND aggregate_id = :mpr AND payload->>'newStatus' = 'merged') = 1 AS pr_merged_event_ok,
       count(*) FILTER (WHERE aggregate_type = 'issue' AND payload->>'newStatus' = 'closed') >= 1 AS issue_closed_event_ok
FROM outbox WHERE id > (SELECT coalesce(max(id), 0) FROM outbox WHERE id <= :m0_max);
ROLLBACK;

\echo '=== G. the worker query and the table shape'
SELECT indexdef LIKE '%(next_attempt_at, id)%processed_at IS NULL%' AS pending_index_ok FROM pg_indexes WHERE indexname = 'idx_outbox_pending';
