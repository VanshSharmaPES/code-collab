# Database setup (P1-04)

Targets: PostgreSQL 16, MongoDB 7. Check what you already have first:

```bash
psql --version && mongosh --version
```

## PostgreSQL 16

### Fedora
Fedora's default repos may ship a newer major version than 16. To match the team version, use the PGDG repo:

```bash
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/F-$(rpm -E %fedora)-x86_64/pgdg-fedora-repo-latest.noarch.rpm
sudo dnf install -y postgresql16-server postgresql16-contrib
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
```

If PGDG has no build for your Fedora release, install the distro version (`sudo dnf install postgresql-server postgresql-contrib`) and tell the other person which major version you have. The schema uses nothing newer than 16.

### Ubuntu / Debian
```bash
sudo apt install -y postgresql-16 postgresql-contrib
```

### Create the database and app user
```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE codecollab LOGIN PASSWORD 'change_me';
CREATE DATABASE codecollab OWNER codecollab;
SQL
```

If password login is refused on Fedora, change `ident` to `scram-sha-256` for the `127.0.0.1/32` and `::1/128` lines in `pg_hba.conf`, then restart the service.

Copy `.env.example` to `.env` and set `DATABASE_URL` to match.

### Verify
```bash
psql "$DATABASE_URL" -c 'select version();'
```

## pgvector (only needed if Week 6 goes ahead)
Install now so it is not a surprise later:
```bash
sudo dnf install -y pgvector_16      # PGDG package name; on Debian: postgresql-16-pgvector
```

## MongoDB 7

Add the official MongoDB 7.0 repo for your distro (see https://www.mongodb.com/docs/v7.0/administration/install-on-linux/), then:

```bash
sudo dnf install -y mongodb-org
sudo systemctl enable --now mongod
```

### Verify
```bash
mongosh --eval 'db.runCommand({ ping: 1 })'
```

## Load the schema

```bash
./db/apply.sh        # drops and recreates the public schema, then applies db/schema/*.sql
```

This destroys everything in the target database. Use it on a dev database only.
