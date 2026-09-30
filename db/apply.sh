#!/usr/bin/env bash
# Drop and recreate the codecollab schema from db/schema/*.sql, then load db/seed/dev_*.sql.
# Usage: DATABASE_URL=postgresql://... ./db/apply.sh   (reads .env if DATABASE_URL is unset)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${DATABASE_URL:?DATABASE_URL is not set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
for f in db/schema/*.sql db/seed/dev_*.sql; do
  [ -e "$f" ] || continue
  echo "applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "done"
