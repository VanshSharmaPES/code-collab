# Query tuning (P1-14)

## Method
- Measured on a separate database, `codecollab_perf`: the seed scaled up with `db/perf/scale_up.sql` to 1,015,000 commits, 154,000 issues and 82,000 pull requests. On the 21,000-row development data every query already finishes in a few milliseconds, so differences there are noise.
- Environment: PostgreSQL 16.15 (`pgvector/pgvector:pg16` image) with default settings (`shared_buffers` 128 MB, `work_mem` 4 MB, JIT on), in rootless Podman on a 12-core laptop with 7 GB of memory. Absolute times depend on the machine and its load; compare the columns of one table, not numbers from different machines.
- `db/perf/measure.sh` runs each query in `db/queries/` under `EXPLAIN (ANALYZE, BUFFERS)` after one warm-up run and reports the median. The plan of each step is in `db/perf/results/` (`before_*`, `step1_view_*`, `after_*`).
- One change at a time, measured after each.
- Query results were saved before and after (`results/before_output.txt`, `results/after_output.txt`). Q1, Q3 and Q4 are identical. Q2 depends on `now()`, so between the two runs `days_since_update` moved by a day and six more issues crossed the 14-day line.

## Results (ms)
| Query | Before | After view fix | After indexes |
|---|---|---|---|
| Q1 top contributors | 2180 | 1828 | 281 |
| Q2 stale high-priority issues | 21 | 28 | 1.5 |
| Q3 reviewers who do not review | 346 | 365 | 139 |
| Q4a score histogram | 1101 | 1189 | 300 |
| Q4b score statistics | 7967 | 1187 | 302 |

Differences of about 10% between runs are noise: Q2 does not read the view, yet moved from 21 to 28 ms in the view-fix step.

**Rerun on 3 Nov** (same database, the machine just after a reboot and busier), with and without the four indexes, the view fence kept:

| Query | Without indexes | With indexes |
|---|---|---|
| Q1 | 2295 | 662 |
| Q2 | 20.5 | 3.6 |
| Q3 | 379 | 189 |
| Q4a | 1164 | 317 |
| Q4b | 1173 | 287 |

The gains reproduce. Q1 with indexes is slower than on the first run although its plan and buffer counts (905 hits) are identical; every plan node took about 2.4 times as long, which is the machine, not the query.

## Findings
1. **Repeated work in `member_contribution_v`.** Postgres inlined `contribution_counts` into the view and re-ran its counting subqueries for every reference to a count or to `score`; Q4b uses `score` in nine aggregates. An `OFFSET 0` fence makes the counts compute once per member, with identical results: Q4b fell from 7967 to 1187 ms, and Q1's per-member counting passes from 8 to 4. `OFFSET 0` blocking subquery flattening is long-standing planner behaviour rather than a documented guarantee, so re-check this after a major PostgreSQL upgrade (the step-1 plans show what to look for).
2. **JIT compilation was a symptom, not a cause.** The inflated cost estimates triggered full JIT compilation (753 ms in Q1). After the fence the estimates fell below the optimisation threshold and JIT dropped to 90 ms by itself, so the setting was left at its default.
3. **Indexes.** `commits (repository_id, author_id)`, `pull_requests (repository_id, author_id, status)` and `pr_reviews (reviewer_id, pull_request_id)` turn the per-member counts into index-only scans (`Heap Fetches: 0`). A partial index on unresolved high and critical issues serves Q2. `idx_pr_reviews_reviewer` was dropped as redundant; `idx_commits_author` and `idx_pull_requests_author` were kept for the `ON DELETE SET NULL` lookups.

## Trade-offs
- Each index slows inserts and updates on its table slightly and uses disk. These tables are read far more often than written, so the trade is worth it.
- `Heap Fetches: 0` is the best case: `scale_up.sql` ends with `VACUUM ANALYZE`, so every page was marked all-visible. On a table with recent writes that autovacuum has not reached yet, an index-only scan has to visit some heap pages again and is slower than measured here.
