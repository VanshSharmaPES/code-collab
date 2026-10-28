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

## Similarity search (P2-17, P2-18)
- **Database:** `db/schema/08_embeddings.sql` enables the `vector` extension, creates the `embeddings` table and builds an HNSW index with cosine distance. It needs a PostgreSQL with pgvector (the `pgvector/pgvector:pg16` image from `db/setup.md` has it) and is safe to run more than once. It stands in for the P1-17 step of the work split plan; if P1-17 is written differently, that version replaces this file. Apply it yourself, for example `docker exec -i cc-postgres psql -U codecollab -d codecollab -v ON_ERROR_STOP=1 -1 -q < db/schema/08_embeddings.sql`.
- **`npm run embed`** (dry run) counts the issues, commits and pull requests that have no embedding yet. `npm run embed -- --apply` embeds them with a local sentence-transformer (`Xenova/all-MiniLM-L6-v2`, 384 numbers per text, no API or key; about 25 MB, downloaded the first time and cached). Options: `--kind=issues|commits|pull-requests|all` and `--limit=N` (default 1000 per kind; try `--limit=100` first). About 35 texts per second on a laptop, so the whole ingested set takes roughly a quarter of an hour. It is safe to stop and rerun: rows that are done are skipped, and an issue or pull request is embedded again only if its text changed. It only opens the local `codecollab` database.
- **`/search`** shows a keyword search (PostgreSQL full-text search) and a semantic search (nearest vectors) side by side for the same text, with links to the issue and pull request pages. If the embeddings are missing or the model cannot load, the keyword side still works and the semantic side says it is unavailable.
- **Tests:** `npm test` checks the logic with a fake database and a fake model. To also check against a real PostgreSQL with pgvector, run `TEST_PG_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5433/postgres npm test` (the test creates its own `cc_embed_test_*` database and drops it) and add `TEST_REAL_MODEL=1` to include the real model.
- **Access:** like the issue and pull request pages, search shows every project's rows to any signed-in user. Project-scoped access is the P1-07 work.
