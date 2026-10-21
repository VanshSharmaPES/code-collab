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
