-- P1-10: two triggers.
--   1. Status-change auditing for pull requests and issues.
--   2. A reviewer may not review their own pull request.

-- ---------------------------------------------------------------------------
-- 1. Status-change audit
-- ---------------------------------------------------------------------------
-- One generic function serves both tables; the entity type is passed as a trigger
-- argument. Two session settings, both transaction-local, let the application and the
-- merge procedure talk to the trigger:
--   codecollab.actor_id  the user making the change (the app sets it per request;
--                        without it the audit row has actor_id NULL)
--   codecollab.merging   'on' while merge_pull_request runs, which writes its own,
--                        richer audit rows, so the trigger stays quiet
CREATE OR REPLACE FUNCTION audit_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_actor BIGINT;
BEGIN
    IF current_setting('codecollab.merging', true) = 'on' THEN
        RETURN NULL;
    END IF;

    v_actor := nullif(current_setting('codecollab.actor_id', true), '')::bigint;

    INSERT INTO audit_log (entity_type, entity_id, action, old_status, new_status, actor_id, details)
    VALUES (TG_ARGV[0], NEW.id, 'status_change', OLD.status, NEW.status, v_actor,
            jsonb_build_object('table', TG_TABLE_NAME));
    RETURN NULL;   -- AFTER trigger: the return value is ignored
END;
$$;

CREATE TRIGGER trg_pull_requests_status_audit
    AFTER UPDATE OF status ON pull_requests
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION audit_status_change('pull_request');

CREATE TRIGGER trg_issues_status_audit
    AFTER UPDATE OF status ON issues
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION audit_status_change('issue');

-- ---------------------------------------------------------------------------
-- 2. No self-review
-- ---------------------------------------------------------------------------
-- reviewer_id is nullable only because ON DELETE SET NULL blanks it when a user is
-- deleted. That blanking is itself an UPDATE on pr_reviews and fires this trigger, so a
-- NULL reviewer must be allowed on UPDATE but never accepted on INSERT.
-- A bare "reviewer_id = author_id" would also be wrong: comparing with NULL yields NULL,
-- not true, and the check would silently pass.
CREATE OR REPLACE FUNCTION prevent_self_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_author BIGINT;
BEGIN
    IF NEW.reviewer_id IS NULL THEN
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'a review must have a reviewer'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    SELECT author_id INTO v_author FROM pull_requests WHERE id = NEW.pull_request_id;

    IF v_author IS NOT NULL AND v_author = NEW.reviewer_id THEN
        RAISE EXCEPTION 'user % cannot review their own pull request %',
            NEW.reviewer_id, NEW.pull_request_id
            USING ERRCODE = 'check_violation',
                  HINT = 'Ask another team member to review it.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pr_reviews_no_self_review
    BEFORE INSERT OR UPDATE OF reviewer_id, pull_request_id ON pr_reviews
    FOR EACH ROW
    EXECUTE FUNCTION prevent_self_review();
