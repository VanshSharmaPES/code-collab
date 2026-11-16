# CodeCollab

A contribution-aware collaboration and verification platform for student software teams. CodeCollab records who did what in a team project (commits, pull requests, reviews, issues) and turns it into evidence a mentor can check, instead of relying on self-reported effort.

Mini project for the Database Management Systems course at PES University.

## Status

Both databases, the ingestion pipeline and the similarity search are built and tested. The web interface is finished.

| Area | State |
|---|---|
| PostgreSQL schema, constraints, triggers, procedures, views | Done (16 tables, `db/schema/01`–`11`) |
| Analytical queries and index tuning | Done, measured on a 1.2-million-row database (`docs/index_tuning.md`) |
| GitHub ingestion into PostgreSQL | Done (`npm run ingest`) |
| MongoDB collections, outbox sync, analytics | Done (`npm run mongo:setup`, `npm run outbox`, `npm run analytics`) |
| Embeddings and semantic search | Done (`npm run embed`, `/search`, `similar_issues`, `recommend_reviewers`) |
| Authentication and per-project access control | Done on the server (argon2 passwords, signed session cookies) |
| Application pages | Issues, pull requests, dashboard, contributions, search and users all work |
| Sign-in and navigation | Done: a `/login` page for every role, a header with links to every page, the signed-in name and role, and Sign out |

## Architecture

| Layer | Technology | Holds |
|---|---|---|
| System of record | PostgreSQL 16 | Users, projects, teams, repositories, commits, issues, pull requests, reviews, audit log, contribution metrics, outbox |
| Document store | MongoDB 7 | Activity stream, comment threads, per-commit file changes, expiring notifications |
| Similarity search | pgvector, inside PostgreSQL | Duplicate-issue detection and reviewer recommendation |
| Web application | Next.js 16 (App Router, TypeScript, React 19) | Role-based interface for students, team leads and faculty mentors |

The application talks to PostgreSQL through `node-postgres` with raw parameterised SQL. There is no ORM, so every query in the app is plain SQL that can be read and explained.

PostgreSQL and MongoDB are kept in step by a transactional outbox: a status change writes its event to the `outbox` table in the same transaction as the change, and a worker delivers it to MongoDB at least once.

## Repository layout

```
db/
  schema/      DDL and database objects, applied in file-name order (01-11)
  queries/     the four analytical queries, as standalone SQL
  perf/        scale-up script, measurement harness and saved EXPLAIN plans
  seed/        synthetic dataset for development
  tests/       demonstration scripts; each runs in a transaction and rolls back
  setup.md     how to run PostgreSQL and MongoDB locally
  apply.sh     drop and rebuild the database from schema/ and seed/
docs/
  er.png            ER diagram of the core tables
  er_core.md        Mermaid source of the diagram
  on_delete.md      ON DELETE policy for every foreign key
  index_tuning.md   query timings before and after tuning, with method
scripts/
  seed.ts           insert-only seed skeleton
  ingest.ts         GitHub ingestion into PostgreSQL
  mongo-setup.ts    create MongoDB collections and indexes
  outbox-worker.ts  deliver outbox rows to MongoDB
  load-commit-files.ts  load per-commit file changes into MongoDB
  analytics.ts      read-only MongoDB aggregation reports
  embed.ts          generate embeddings for issues, commits and pull requests
src/
  app/         Next.js routes and server actions
  lib/         database pools, access control, query modules, validation
  proxy.ts     request-level redirect rules
```

Most modules have a `*.test.ts` next to them; `npm test` runs them all.

## Prerequisites

- Podman or Docker, to run the databases
- Node.js 20.19.0 or newer, and npm
- Optional: a local `psql` client, needed only for `db/apply.sh`

## Getting started

### 1. Configure the environment

```bash
cp .env.example .env
```

Fill in at least `DATABASE_URL`, `MONGO_URL` and `SESSION_SECRET` (`openssl rand -base64 32`). `GITHUB_TOKEN` is needed only for ingestion and `SEED_PASSWORD` only for `npm run seed`. The other defaults match the container setup below. `.env` is git-ignored and must never be committed.

### 2. Start the databases

```bash
podman run -d --name cc-postgres \
  -e POSTGRES_USER=codecollab -e POSTGRES_PASSWORD=change_me -e POSTGRES_DB=codecollab \
  -p 5432:5432 -v cc-pgdata:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg16

podman run -d --name cc-mongo \
  -p 27017:27017 -v cc-mongodata:/data/db \
  docker.io/library/mongo:7
```

The pgvector image is required, not optional: `db/schema/08_embeddings.sql` enables the `vector` extension. pgvector 0.8 or newer is needed for the semantic search to return complete results.

After a reboot, `podman start cc-postgres cc-mongo` brings them back with their data. `db/setup.md` covers verification, resets and troubleshooting. Docker users can replace `podman` with `docker` throughout.

### 3. Build the database

On a new, empty database, apply every schema file in order, then load the synthetic dataset:

```bash
for f in db/schema/*.sql; do
  podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < "$f"
done
podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/seed/dev_synthetic.sql
```

If you have a local `psql` client, `./db/apply.sh` does the same in one step. It drops the whole `public` schema first, so use it only on a development database.

### 4. Create the MongoDB collections

```bash
npm install
npm run mongo:setup            # dry run: lists what it would create
npm run mongo:setup -- --apply
```

This creates `activity_events`, `comments`, `commit_files` and `notifications` with their indexes. It only ever creates, never drops, and is safe to rerun.

### 5. Run the application

```bash
npm run dev
```

The app runs on http://localhost:3001. To confirm it can reach PostgreSQL, open http://localhost:3001/api/health/db, which returns `{"status":"ok"}`.

Open http://localhost:3001 and sign in on the login page. Seeded accounts all use the password `password123`:

| Role | Email | Sees |
|---|---|---|
| Mentor | `user01@seed.codecollab.test` | Every member of the projects they mentor, and the dashboard |
| Team lead | `user04@seed.codecollab.test` | The whole project their team belongs to, the dashboard, and can merge approved pull requests |
| Student | `user19@seed.codecollab.test` | Their own project, and only their own row on the contributions page |

`user01` to `user03` are mentors, `user04` to `user18` team leads and `user19` to `user60` students. The header links to every page; **Sign out** ends the session. The JSON endpoints `/api/auth/login` and `/api/auth/logout` still exist for scripts.

Before opening a pull request, `npm run lint`, `npx tsc --noEmit`, `npm run build` and `npm test` should all pass.

## Command reference

Every write command has a dry run by default and needs `-- --apply` to change anything. Each one refuses to run against anything but a local database named `codecollab`.

| Command | Does |
|---|---|
| `npm test` | Unit tests with fake databases and a fake embedding model. Set `TEST_PG_ADMIN_URL`, `TEST_MONGO_URL` or `TEST_REAL_MODEL=1` to also run the integration tests. |
| `npm run seed` | Insert-only skeleton: 4 users and 2 projects. Separate from `db/seed/dev_synthetic.sql`. |
| `npm run ingest` | Load real repositories from GitHub into PostgreSQL. Default targets are `pallets/flask`, `expressjs/express` and `pallets/click`. A full run is roughly 15,500 requests, so 3 to 4 hours at GitHub's rate limit; it resumes safely. |
| `npm run mongo:setup` | Create MongoDB collections and indexes. |
| `npm run outbox` | Deliver status-change events from the `outbox` table to `activity_events`. Add `--once` to drain and exit. |
| `npm run load:commit-files` | Load `tmp/ingest/*.commit-files.jsonl` into `commit_files`. |
| `npm run analytics -- <report>` | Read-only MongoDB reports: `monthly`, `files`, `events`. |
| `npm run embed` | Embed issues, commits and pull requests with a local sentence-transformer (`Xenova/all-MiniLM-L6-v2`, 384 dimensions, no API key). About 35 texts a second. |

Ingestion keeps personal data to a minimum: commit author names and emails are never stored, and email addresses inside titles, bodies and messages are replaced with `[email redacted]`.

`CONTRIBUTING.md` documents each of these in full, including the access rules and the guards.

## Synthetic dataset

`db/seed/dev_synthetic.sql` generates 60 users, 15 projects, 4,000 issues, 2,000 pull requests and 15,000 commits, with teams, labels, reviews and links between pull requests and issues. The data is shaped to be worth analysing: activity comes in bursts before deadlines, each team has one dominant contributor and one member who never reviews, and some high-priority issues go stale.

- Every seeded row is tagged (`@seed.codecollab.test` emails, `repositories.is_synthetic = TRUE`), so the script can be rerun safely and never touches real ingested data.
- Timestamps are relative to the day the seed runs. Rerun it before a demo to keep "last 7 days" figures meaningful.
- Development logins, all with the password `password123`:

  | Email | Role |
  |---|---|
  | `user01@seed.codecollab.test` | Faculty mentor |
  | `user04@seed.codecollab.test` | Team lead |
  | `user19@seed.codecollab.test` | Student |

These credentials exist only in the local synthetic dataset.

For performance work, `db/perf/scale_up.sql` grows a separate `codecollab_perf` database to 1,015,000 commits, 154,000 issues and 82,000 pull requests.

## Database design

Sixteen tables. The fourteen core ones are shown in `docs/er.png`:

- **Core:** `users`, `projects`, `teams`, `team_members`, `repositories`, `commits`, `issues`, `pull_requests`
- **Collaboration:** `pr_reviews`, `pr_issue_links`, `labels`, `issue_labels`
- **Accountability:** `audit_log`, `contribution_metrics`
- **Added since the diagram:** `outbox` (PostgreSQL-to-MongoDB events), `embeddings` (pgvector)

Integrity is enforced in the database, not only in the application: CHECK constraints on every status and priority, composite UNIQUE keys (one issue number per repository, one review per reviewer per pull request), and a documented ON DELETE rule for each of the 25 foreign keys (`docs/on_delete.md`).

### Database objects

| Object | Kind | Purpose |
|---|---|---|
| `merge_pull_request(pr_id, merger_id)` | Stored procedure | Merges an approved pull request in one transaction: locks the row, validates it, closes linked issues, writes the audit trail and updates metrics. Any failure undoes all of it. |
| `refresh_contribution_metrics(project_id)` | Stored procedure | Rebuilds `contribution_metrics`, for one project or all of them. |
| `trg_pull_requests_status_audit`, `trg_issues_status_audit` | Triggers | Record every status change in `audit_log` |
| `trg_pull_requests_status_outbox`, `trg_issues_status_outbox` | Triggers | Write every status change to `outbox`, in the same transaction |
| `trg_pr_reviews_no_self_review` | Trigger | Stops a user from reviewing their own pull request |
| `contribution_score(user_id, project_id)` | Function | Weighted score: commit 1, merged pull request 5, review 3, closed issue 2 |
| `contribution_counts(user_id, project_id)` | Function | The four raw counts behind the score |
| `similar_issues(issue_id, model, limit, min_similarity)` | Function | Possible duplicates of an issue, from the same project, most similar first |
| `recommend_reviewers(pr_id, model, limit, neighbours)` | Function | Reviewers scored from the most similar pull requests of the project, excluding the author and existing reviewers |
| `project_dashboard_v` | View | One row per project with issue, pull request and commit counts |
| `member_contribution_v` | View | One row per member per project, with counts and score |

Neither similarity function checks who is asking. Callers must apply the participant check first; the application does this in `src/lib/project-access.ts`.

### Access control

A **participant** of a project is its mentor, the lead of one of its teams, or a member of one of its teams. Issues, pull requests, repositories and search results are visible only to participants, and a non-participant gets "not found" rather than "forbidden", so the existence of other projects' rows is not revealed. The check lives inside every query, and the viewer is always the signed-in user. Permission follows a person's place in a project, not the `role` column, so a forged or stale role claim cannot widen access. Full rules are in `CONTRIBUTING.md`.

### Demonstration scripts

Each script in `db/tests/` runs inside a transaction and rolls back at the end, so it can be run any number of times without changing the data:

```bash
podman exec -i cc-postgres psql -U codecollab < db/tests/merge_demo.sql
```

| Script | Shows |
|---|---|
| `on_delete_demo.sql` | SET NULL, RESTRICT and CASCADE on real rows |
| `merge_demo.sql` | A deliberately failed merge that leaves the database unchanged, then a successful one |
| `triggers_demo.sql` | Status auditing, and self-review being rejected |
| `views_demo.sql` | View totals reconciled against the raw tables, and the score checked by hand |
| `integrity_tests.sql` | Constraints rejecting bad rows |
| `outbox_demo.sql` | A status change and its outbox row committing together |
| `refresh_tests.sql` | `refresh_contribution_metrics` against live counts |
| `similarity_tests.sql` | `similar_issues` and `recommend_reviewers` on hand-made vectors |

## Team

| Member | Owns |
|---|---|
| [@VanshSharmaPES](https://github.com/VanshSharmaPES) | Relational schema, constraints, transactions, triggers, procedures, views, analytical queries, index tuning, access control, synthetic data, similarity queries |
| [@Shubhikapradeep](https://github.com/Shubhikapradeep) | MongoDB collections and pipelines, PostgreSQL-to-MongoDB synchronisation, GitHub ingestion, embeddings and semantic search, application pages, security hardening |

How we branch, commit and review is in `CONTRIBUTING.md`.
