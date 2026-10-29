# Contributing

## Branches
- `main` is always runnable. Do not commit to it directly.
- One branch per feature: `feature/<task-id>-<short-name>`, e.g. `feature/p1-03-core-schema`.
- Open a pull request into `main`. The other person reviews at least one PR per week.

## Commits
- Commit under your own GitHub account, small and often. Do not batch work into the final weeks.
- Start the message with the task ID from `plan.md`: `P1-03: add core schema DDL`.

## Secrets
- Never commit `.env`. Add new variables to `.env.example` with placeholder values.

## Running the app locally
- `npm install`, then `cp .env.example .env` if you have no `.env` yet (database setup is in `db/setup.md`).
- `npm run dev` serves http://localhost:3001.
- Before opening a PR: `npm run lint`, `npx tsc --noEmit` and `npm run build` should all pass.

## Seed skeleton (P2-05)
- `npm run seed` is a dry run: it prints what it would insert and writes nothing.
- `SEED_PASSWORD='<8-128 chars>' npm run seed -- --apply` inserts 4 users (`@skeleton.codecollab.test`) and 2 projects (`Skeleton: ...`). Setting `SEED_PASSWORD` in `.env` also works.
- It is insert-only and safe to rerun: rows whose email (users) or name (projects) already exist are skipped, and existing accounts keep their old password. Any other conflict, such as a taken GitHub username or a mentor who is missing or not a mentor, stops the run and rolls everything back.
- It only writes to a local database named `codecollab` (it refuses production, remote hosts and other database names) and prints the target before connecting.
- It is separate from `db/seed/dev_synthetic.sql` (P1-06), which loads the full dataset.

## GitHub ingestion (P2-06)
- `npm run ingest` is a dry run: it reads repository sizes from GitHub (a few read-only requests), prints the estimated request count, and writes nothing. The default repositories are `pallets/flask`, `expressjs/express` and `pallets/click`; pass `owner/name` arguments to choose others.
- `npm run ingest -- --apply` loads repositories, commits (with additions, deletions and file counts), issues and pull requests into PostgreSQL, one project per repository. It needs `GITHUB_TOKEN` in `.env` and a local `codecollab` database (the same guard as the seed). `--limit=N` caps each kind per repository: try `-- --apply --limit=20` first.
- A full run is about 15,500 requests, which is roughly 3 to 4 hours at the 5,000 requests an hour a token allows. It waits for the rate limit to reset by itself, saves each page as it goes, and is safe to stop and rerun: stored commits are skipped, and issues and pull requests are only updated when GitHub's copy is newer than ours.
- Authors are linked to existing users by GitHub username (case-insensitive); anyone else is stored as no account. `merged_by` and issue priority are not filled in, and `approved` pull requests and `in_progress` issues do not exist on GitHub.
- Personal data is kept to a minimum. Commit author names and emails are **not stored**: `commits.author_name` and `commits.author_email` (nullable, unused by any feature) stay empty for ingested rows. Email addresses inside commit messages, issue and pull request titles and bodies, and repository descriptions are replaced with `[email redacted]`; the rest of the text, including trailer lines like `Co-authored-by: Name <...>`, is kept (so names written in trailers remain, and an SSH remote such as `git@github.com` is redacted too). Rows ingested before this change are not rewritten by a rerun, because stored commits are skipped.
- The schema has no table for the files a commit changed. They are written to `tmp/ingest/<owner>__<repo>.commit-files.jsonl` (git-ignored, one line per commit, no patch text) for the later MongoDB load. Each line holds the commit's sha and date, the file changes, and `author_login`: the author's public GitHub login, or null when the commit has no linked GitHub account. Never a name or email. Lines written by earlier runs lack `author_login` and are left as they are. Keep those files: rebuilding them means fetching every commit again.

## MongoDB collections and indexes (P2-09)
- `npm run mongo:setup` is a dry run: it connects to the local MongoDB (`MONGO_URL` in `.env`, see `.env.example`), lists what exists and what it would create, and writes nothing.
- `npm run mongo:setup -- --apply` creates the `activity_events`, `comments`, `commit_files` and `notifications` collections and their indexes in the `codecollab` database. Notifications expire at their own `expiresAt` through a TTL index (`expireAfterSeconds: 0`).
- It only creates. It never drops or renames anything and never touches documents. It is safe to rerun: collections and indexes that already exist are left alone. If an index exists under the same name with a different definition, it stops with a message and changes nothing, so you can decide what to do in `mongosh`.
- It refuses to run unless `MONGO_URL` is a single local server (`localhost`, `127.0.0.1` or `::1`) and the database is named `codecollab`, so it cannot touch the other databases on a shared local server.

## Outbox and MongoDB sync (P2-10)
- Apply `db/schema/07_outbox.sql` (it is safe to run again). It adds the `outbox` table and, next to the audit trigger of P1-10, one trigger on `issues` and one on `pull_requests`. Every status change inserts an `issue.status_changed` or `pull_request.status_changed` row into `outbox` in the same transaction as the change, so both commit or both roll back. The merge procedure's changes are included. Creating a row does not emit an event, so the seed and the ingestion do not flood the outbox.
- `npm run outbox` shows how many rows are pending, parked and delivered, and changes nothing.
- `npm run outbox -- --apply` delivers due rows to the `activity_events` collection (run `npm run mongo:setup -- --apply` first; this task needs P2-09). It keeps running until Ctrl-C; add `--once` to deliver what is due and exit, and `--interval=MS` to change the polling pause.
- Delivery is at-least-once and safe to repeat: each event is stored under its outbox row id (unique index `activity_outbox_id_unique`), and a repeat leaves the stored event unchanged. A failed row is retried after 5 s, 10 s, 20 s and so on (at most an hour apart) and is parked after 10 failures; nothing is marked delivered unless MongoDB accepted it. If MongoDB is down the worker stops each batch after 3 failures in a row.
- It uses the same local-only guards as the seed (PostgreSQL database `codecollab`) and `mongo:setup` (MongoDB database `codecollab`).
