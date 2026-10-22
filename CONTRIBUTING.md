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
