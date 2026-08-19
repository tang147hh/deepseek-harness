#!/bin/sh
# Dump the platform Postgres (dsh-postgres) with docker exec + pg_dump.
# Does not copy user volumes or site snapshots. Do not delete /data.
# Usage: backup-postgres.sh [outdir]
# Default outdir: /data/backups
set -eu

CONTAINER="${POSTGRES_CONTAINER:-dsh-postgres}"
USER_NAME="${POSTGRES_USER:-dsh}"
DB_NAME="${POSTGRES_DB:-dsh}"
OUTDIR="${1:-/data/backups}"

mkdir -p "$OUTDIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTFILE="${OUTDIR}/dsh-${STAMP}.sql"

# pg_dump runs inside the container; stdout is the dump on the host.
# Do not pass POSTGRES_PASSWORD on the command line.
docker exec "$CONTAINER" pg_dump -U "$USER_NAME" -d "$DB_NAME" --no-owner --no-acl --no-password > "$OUTFILE"

echo "wrote ${OUTFILE}"
