-- CodeCollab remaining tables (P1-05): the other six of the fourteen.
-- Depends on 01_core.sql. ON DELETE choices follow docs/on_delete.md (P1-08).

BEGIN;

-- One verdict by one reviewer on one pull request.
CREATE TABLE pr_reviews (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pull_request_id  BIGINT      NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    reviewer_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    verdict          TEXT        NOT NULL
                     CHECK (verdict IN ('approved', 'changes_requested', 'commented')),
    body             TEXT,
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pull_request_id, reviewer_id)
);

-- Which issues a pull request closes when it merges. Junction table.
CREATE TABLE pr_issue_links (
    pull_request_id  BIGINT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    issue_id         BIGINT NOT NULL REFERENCES issues (id)        ON DELETE CASCADE,
    PRIMARY KEY (pull_request_id, issue_id)
);

CREATE TABLE labels (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT   NOT NULL,
    color       TEXT   NOT NULL DEFAULT '#888888'
                CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    UNIQUE (project_id, name)
);

CREATE TABLE issue_labels (
    issue_id  BIGINT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
    label_id  BIGINT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
);

-- Append-only history of changes. entity_id is deliberately not a foreign key
-- because one column points at several different tables.
CREATE TABLE audit_log (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type  TEXT        NOT NULL
                 CHECK (entity_type IN ('issue', 'pull_request', 'project', 'team')),
    entity_id    BIGINT      NOT NULL,
    action       TEXT        NOT NULL,
    old_status   TEXT,
    new_status   TEXT,
    actor_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per member per project, rebuilt by the refresh procedure (P1-15).
CREATE TABLE contribution_metrics (
    project_id     BIGINT  NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id        BIGINT  NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
    commits        INTEGER NOT NULL DEFAULT 0 CHECK (commits >= 0),
    prs_opened     INTEGER NOT NULL DEFAULT 0 CHECK (prs_opened >= 0),
    prs_merged     INTEGER NOT NULL DEFAULT 0 CHECK (prs_merged >= 0),
    reviews_given  INTEGER NOT NULL DEFAULT 0 CHECK (reviews_given >= 0),
    issues_closed  INTEGER NOT NULL DEFAULT 0 CHECK (issues_closed >= 0),
    score          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (score >= 0),
    refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

-- Extra integrity rules on the core tables.
-- Not added: "status = merged requires merged_by". It conflicts with
-- merged_by ON DELETE SET NULL (decided in P1-08, see docs/on_delete.md row 15).
ALTER TABLE users
    ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    ADD CONSTRAINT users_email_has_at    CHECK (position('@' in email) > 1);

ALTER TABLE issues
    ADD CONSTRAINT issues_updated_after_created CHECK (updated_at >= created_at),
    ADD CONSTRAINT issues_closed_after_created  CHECK (closed_at IS NULL OR closed_at >= created_at);

ALTER TABLE pull_requests
    ADD CONSTRAINT prs_updated_after_created CHECK (updated_at >= created_at),
    ADD CONSTRAINT prs_merged_after_created  CHECK (merged_at IS NULL OR merged_at >= created_at);

ALTER TABLE commits
    ADD CONSTRAINT commits_sha_hex CHECK (sha ~ '^[0-9a-f]{7,40}$');

-- Indexes for the lookups the merge procedure and analytics use.
-- UNIQUE and PRIMARY KEY constraints already create their own indexes.
CREATE INDEX idx_pr_reviews_reviewer      ON pr_reviews (reviewer_id);
CREATE INDEX idx_pr_issue_links_issue     ON pr_issue_links (issue_id);
CREATE INDEX idx_issue_labels_label       ON issue_labels (label_id);
CREATE INDEX idx_audit_log_entity         ON audit_log (entity_type, entity_id, created_at);

COMMIT;
