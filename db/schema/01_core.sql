-- CodeCollab core schema (P1-03): the eight core tables.
-- The remaining six tables and the full constraint pass come in 02_rest.sql (P1-05).
-- ON DELETE choices here are provisional; P1-08 finalises and justifies them.

BEGIN;

-- Users: every account. Role drives server-side access control (P1-07).
CREATE TABLE users (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email          TEXT        NOT NULL UNIQUE,
    full_name      TEXT        NOT NULL,
    password_hash  TEXT        NOT NULL,          -- argon2 hash, produced by the app
    role           TEXT        NOT NULL DEFAULT 'student'
                   CHECK (role IN ('student', 'lead', 'mentor')),
    github_username TEXT       UNIQUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT        NOT NULL UNIQUE,
    description  TEXT,
    status       TEXT        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'archived')),
    mentor_id    BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    lead_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE team_members (
    team_id    BIGINT      NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE repositories (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id     BIGINT      NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    github_url     TEXT        UNIQUE,
    default_branch TEXT        NOT NULL DEFAULT 'main',
    is_synthetic   BOOLEAN     NOT NULL DEFAULT FALSE,  -- separates seeded from ingested data
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE commits (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
    sha            TEXT        NOT NULL,
    author_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL, -- NULL for GitHub authors with no account
    author_name    TEXT,
    author_email   TEXT,
    message        TEXT        NOT NULL,
    additions      INTEGER     NOT NULL DEFAULT 0 CHECK (additions >= 0),
    deletions      INTEGER     NOT NULL DEFAULT 0 CHECK (deletions >= 0),
    files_changed  INTEGER     NOT NULL DEFAULT 0 CHECK (files_changed >= 0),
    committed_at   TIMESTAMPTZ NOT NULL,
    UNIQUE (repository_id, sha)
);

CREATE TABLE issues (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
    number         INTEGER     NOT NULL,
    title          TEXT        NOT NULL,
    body           TEXT,
    status         TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'in_progress', 'closed')),
    priority       TEXT        NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    author_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    assignee_id    BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at      TIMESTAMPTZ,
    UNIQUE (repository_id, number),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE pull_requests (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repository_id  BIGINT      NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
    number         INTEGER     NOT NULL,
    title          TEXT        NOT NULL,
    description    TEXT,
    status         TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'approved', 'merged', 'closed')),
    author_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    merged_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at      TIMESTAMPTZ,
    UNIQUE (repository_id, number),
    CHECK ((status = 'merged') = (merged_at IS NOT NULL))
);

-- Indexes on foreign keys that the app and the Week 3+ queries filter on.
-- Full index tuning with EXPLAIN ANALYZE evidence is P1-14.
CREATE INDEX idx_commits_author       ON commits (author_id);
CREATE INDEX idx_commits_committed_at ON commits (committed_at);
CREATE INDEX idx_issues_assignee      ON issues (assignee_id);
CREATE INDEX idx_pull_requests_author ON pull_requests (author_id);

COMMIT;
