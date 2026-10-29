# Query tuning (P1-14)

## Method
- Measured on a separate database, `codecollab_perf`: the seed scaled up with `db/perf/scale_up.sql` to 1,015,000 commits, 154,000 issues and 82,000 pull requests. On the 21,000-row development data every query already finishes in a few milliseconds, so differences there are noise.
- `db/perf/measure.sh` runs each query in `db/queries/` under `EXPLAIN (ANALYZE, BUFFERS)` after one warm-up run and reports the median. Full plans are in `db/perf/results/`.
- One change at a time, measured after each.
- Query results were saved before and after and compared with `diff`: identical apart from `days_since_update`, which moves with the date.

## Results (ms)
| Query | Before | After view fix | After indexes |
|---|---|---|---|
| Q1 top contributors | 2180 | 1828 | 281 |
| Q2 stale high-priority issues | 21 | 28 | 1.5 |
| Q3 reviewers who do not review | 346 | 365 | 139 |
| Q4a score histogram | 1101 | 1189 | 300 |
| Q4b score statistics | 7967 | 1187 | 302 |

## Findings
1. **Repeated work in `member_contribution_v`.** Postgres inlined `contribution_counts` into the view and re-ran its counting subqueries for every reference to a count or to `score`; Q4b uses `score` in nine aggregates. An `OFFSET 0` fence makes the counts compute once per member, with identical results: Q4b fell from 7967 to 1187 ms, and Q1's per-member counting passes from 8 to 4.
2. **JIT compilation was a symptom, not a cause.** The inflated cost estimates triggered full JIT compilation (753 ms in Q1). After the fence the estimates fell below the optimisation threshold and JIT dropped to 90 ms by itself, so the setting was left at its default.
3. **Indexes.** `commits (repository_id, author_id)`, `pull_requests (repository_id, author_id, status)` and `pr_reviews (reviewer_id, pull_request_id)` turn the per-member counts into index-only scans (`Heap Fetches: 0`). A partial index on unresolved high and critical issues serves Q2. `idx_pr_reviews_reviewer` was dropped as redundant; `idx_commits_author` and `idx_pull_requests_author` were kept for the `ON DELETE SET NULL` lookups.

## Trade-offs
Each index slows inserts and updates on its table slightly and uses disk. These tables are read far more often than written, so the trade is worth it.
