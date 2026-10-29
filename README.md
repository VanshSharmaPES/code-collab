# CodeCollab

A contribution-aware collaboration and verification platform for student software teams. CodeCollab records who did what in a team project (commits, pull requests, reviews, issues) and turns it into evidence a mentor can check, instead of relying on self-reported effort.

Mini project for the Database Management Systems course at PES University.

## Architecture

| Layer | Technology | Holds |
|---|---|---|
| System of record | PostgreSQL 16 | Users, projects, teams, repositories, commits, issues, pull requests, reviews, audit log, contribution metrics |
| Document store | MongoDB 7 | Activity stream, comment threads, per-commit file changes, expiring notifications (planned) |
| Similarity search | pgvector, inside PostgreSQL | Duplicate-issue detection and reviewer recommendation (optional, decided on 1 November) |
| Web application | Next.js (App Router, TypeScript) | Role-based interface for students, team leads and faculty mentors |

The application talks to PostgreSQL through `node-postgres` with raw parameterised SQL. There is no ORM, so every query in the app is plain SQL that can be read and explained.

## Repository layout

```
db/
  schema/      DDL and database objects, applied in file-name order
  seed/        synthetic dataset for development
  tests/       demonstration scripts; each runs in a transaction and rolls back
  setup.md     how to run PostgreSQL and MongoDB locally
  apply.sh     drop and rebuild the database from schema/ and seed/
docs/
  er.png       ER diagram of all 14 tables
  er_core.md   Mermaid source of the diagram
  on_delete.md ON DELETE policy for every foreign key
src/
  app/         Next.js routes, including /api/health/db
  lib/db.ts    shared PostgreSQL connection pool and query helper
```

## Prerequisites

- Podman or Docker, to run the databases
- Node.js 20.9 or newer, and npm
- Optional: a local `psql` client, needed only for `db/apply.sh`

## Getting started

### 1. Configure the environment

```bash
cp .env.example .env
```

The defaults in `.env.example` match the container setup below. `.env` is git-ignored and must never be committed.

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

### 4. Run the application

```bash
npm install
npm run dev
```

The app runs on http://localhost:3001. To confirm it can reach PostgreSQL, open http://localhost:3001/api/health/db, which returns `{"status":"ok"}`.

Before opening a pull request, `npm run lint`, `npx tsc --noEmit` and `npm run build` should all pass.

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

## Database design

Fourteen tables, shown in `docs/er.png`:

- **Core:** `users`, `projects`, `teams`, `team_members`, `repositories`, `commits`, `issues`, `pull_requests`
- **Collaboration:** `pr_reviews`, `pr_issue_links`, `labels`, `issue_labels`
- **Accountability:** `audit_log`, `contribution_metrics`

Integrity is enforced in the database, not only in the application: CHECK constraints on every status and priority, composite UNIQUE keys (one issue number per repository, one review per reviewer per pull request), and a documented ON DELETE rule for each of the 25 foreign keys (`docs/on_delete.md`).

### Database objects

| Object | Kind | Purpose |
|---|---|---|
| `merge_pull_request(pr_id, merger_id)` | Stored procedure | Merges an approved pull request in one transaction: locks the row, validates it, closes linked issues, writes the audit trail and updates metrics. Any failure undoes all of it. |
| `trg_pull_requests_status_audit`, `trg_issues_status_audit` | Triggers | Record every status change in `audit_log` |
| `trg_pr_reviews_no_self_review` | Trigger | Stops a user from reviewing their own pull request |
| `contribution_score(user_id, project_id)` | Function | Weighted score: commit 1, merged pull request 5, review 3, closed issue 2 |
| `project_dashboard_v` | View | One row per project with issue, pull request and commit counts |
| `member_contribution_v` | View | One row per member per project, with counts and score |

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

## Team

| Member | Owns |
|---|---|
| [@VanshSharmaPES](https://github.com/VanshSharmaPES) | Relational schema, constraints, transactions, triggers, procedures, views, analytical queries, index tuning, access control, synthetic data |
| [@Shubhikapradeep](https://github.com/Shubhikapradeep) | MongoDB collections and pipelines, PostgreSQL-to-MongoDB synchronisation, GitHub ingestion, application pages, security hardening |

How we branch, commit and review is in `CONTRIBUTING.md`.
