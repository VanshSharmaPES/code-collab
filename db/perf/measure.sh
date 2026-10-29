#!/usr/bin/env bash
# P1-14: time every analytical query in db/queries/ with EXPLAIN ANALYZE.
#
# Usage:  db/perf/measure.sh <label> [runs]
#   label  a name for this measurement, e.g. "before" or "after"
#   runs   timed runs per query (default 5); one extra untimed run warms the cache first
#
# Prints the median execution time of each query, and saves the full plan of the last
# run to db/perf/results/<label>_<query>.txt as evidence for the report.
# Runs against the codecollab_perf database in the cc-postgres container; PERF_DB,
# PERF_CONTAINER and PERF_USER override those.
set -euo pipefail
cd "$(dirname "$0")/../.."

LABEL=${1:?usage: db/perf/measure.sh <label> [runs]}
RUNS=${2:-5}
DB=${PERF_DB:-codecollab_perf}
OUT=db/perf/results
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

psql_db() { podman exec -i "${PERF_CONTAINER:-cc-postgres}" psql -U "${PERF_USER:-codecollab}" -d "$DB" -X -q -t -A -v ON_ERROR_STOP=1; }

printf '%-34s %12s\n' "query ($LABEL, $RUNS runs)" "median ms"
for f in db/queries/0*.sql; do
    base=$(basename "$f" .sql)
    # Split the file into statements: skip comment lines, end a statement at a line
    # that ends with a semicolon. Files with one statement give <base>; files with
    # several give <base>_1, <base>_2, ...
    awk -v dir="$TMP" -v base="$base" '
        /^[[:space:]]*--/ { next }
        { buf = buf $0 "\n" }
        /;[[:space:]]*$/ { n++; f = dir "/" base "_" n ".sql"; printf "%s", buf > f; close(f); buf = "" }
    ' "$f"
    count=$(ls "$TMP"/"$base"_*.sql | wc -l)
    for stmt in "$TMP"/"$base"_*.sql; do
        name=$(basename "$stmt" .sql)
        [ "$count" -eq 1 ] && name=$base
        { echo "EXPLAIN (ANALYZE, BUFFERS)"; cat "$stmt"; } > "$TMP/explain.sql"
        psql_db < "$TMP/explain.sql" > /dev/null                      # warm-up run
        times=()
        for _ in $(seq "$RUNS"); do
            psql_db < "$TMP/explain.sql" > "$TMP/plan.txt"
            times+=("$(grep -oP 'Execution Time: \K[0-9.]+' "$TMP/plan.txt")")
        done
        cp "$TMP/plan.txt" "$OUT/${LABEL}_${name}.txt"
        median=$(printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {print (NR % 2) ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2}')
        printf '%-34s %12.1f\n' "$name" "$median"
    done
    rm -f "$TMP"/"$base"_*.sql
done
