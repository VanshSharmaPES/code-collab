# Database setup (P1-04)

Targets: PostgreSQL 16 (with pgvector) and MongoDB 7. Both run in Podman containers so that every machine has the exact same versions, regardless of distro packages.

Docker works too: replace `podman` with `docker` in every command.

## 1. Start the containers

```bash
# PostgreSQL 16 + pgvector
podman run -d --name cc-postgres \
  -e POSTGRES_USER=codecollab -e POSTGRES_PASSWORD=change_me -e POSTGRES_DB=codecollab \
  -p 5432:5432 -v cc-pgdata:/var/lib/postgresql/data \
  docker.io/pgvector/pgvector:pg16

# MongoDB 7
podman run -d --name cc-mongo \
  -p 27017:27017 -v cc-mongodata:/data/db \
  docker.io/library/mongo:7
```

- `-p host:container` publishes the database port on `localhost`.
- `-v cc-pgdata:...` is a named volume. Data survives removing or recreating the container.
- `POSTGRES_*` variables only take effect the first time the volume is initialised.
- The password above is for local development only. Change it if the port is reachable from other machines.

After a reboot, or if a container is stopped:

```bash
podman start cc-postgres cc-mongo
```

## 2. Verify

```bash
podman exec cc-postgres psql -U codecollab -c 'select version();'
podman exec cc-mongo mongosh --quiet --eval 'db.runCommand({ping:1})'
```

Expected: `PostgreSQL 16.x` and `{ ok: 1 }`.

## 3. Configure the application

```bash
cp .env.example .env
```

The defaults in `.env.example` match the container commands above. If you change the password or port, update `DATABASE_URL` and `MONGO_URL` in `.env` as well. `.env` is git-ignored and must never be committed.

## 4. Load the schema

Without a local `psql` client (works with the containers as-is):

```bash
podman exec -i cc-postgres psql -U codecollab -v ON_ERROR_STOP=1 < db/schema/01_core.sql
podman exec cc-postgres psql -U codecollab -c '\dt'
```

`\dt` should list the tables from the schema files applied so far.

With a local `psql` client installed (`sudo dnf install postgresql` on Fedora), the reset script reads `DATABASE_URL` from `.env` and applies every file in `db/schema/`:

```bash
./db/apply.sh
```

`apply.sh` drops and recreates the whole `public` schema first. Use it on a development database only.

## 5. Interactive shells

```bash
podman exec -it cc-postgres psql -U codecollab
podman exec -it cc-mongo mongosh
```

## 6. Reset from scratch

This deletes all data in both databases.

```bash
podman rm -f cc-postgres cc-mongo
podman volume rm cc-pgdata cc-mongodata
```

Then repeat step 1.

## pgvector

The `pgvector/pgvector:pg16` image already includes the extension. It is only enabled when needed (Week 6, if that week goes ahead):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Troubleshooting

- **Port already in use:** another Postgres or Mongo is already listening on 5432 or 27017. Stop it, or map a different host port (e.g. `-p 5433:5432`) and update `.env`.
- **`no container with name ...`:** you ran a verify command before the matching `podman run`. Start the container first.
- **Container name already exists:** `podman start cc-postgres`, or `podman rm cc-postgres` to recreate it (the volume keeps the data).
