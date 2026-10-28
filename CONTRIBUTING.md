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

## Who can see and change what (P1-07, partial)
- A **participant** of a project is its mentor, the lead of one of its teams, or a member of one of its teams. Issues, pull requests and repositories of a project are visible and writable only to its participants. Anyone else gets "not found" (404 or "no longer exists"), never "forbidden", so the existence of other projects' rows is not revealed. The check is inside every query (`src/lib/project-access.ts`), and the viewer is always the signed-in user.
- **Pull request actions:** any participant who is not the author can approve (the self-review trigger refuses the author); the author, a team lead or the mentor can close and reopen; only a team lead or the mentor can merge (enforced by `merge_pull_request`).
- This is the least-privilege reading of the three roles. The repository only documents that a project is visible to its mentor (`docs/on_delete.md`), so please confirm or correct the rule. Not covered: the `/users` directory (it lists every user, as the week 1 checkpoint required) and role-based API route handlers.
- To check the rules against a real PostgreSQL: `TEST_PG_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5433/postgres npm test` runs `scripts/project-access.integration.test.ts` in its own temporary database. It also exercises the self-review trigger and the merge procedure when `db/schema/03` and `04` are present.
