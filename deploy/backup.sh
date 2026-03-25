#!/bin/bash
# SQLite backup script — run via cron daily at 3:00 AM
# crontab -e → 0 3 * * * /opt/ike-terminal/backup.sh
set -euo pipefail

BACKUP_DIR="/opt/ike-terminal/backups"
DATA_DIR="/opt/ike-terminal/data"
DATE=$(date +%Y%m%d)

mkdir -p "$BACKUP_DIR"

for db in "$DATA_DIR"/*.db; do
  [ -f "$db" ] || continue
  BASENAME=$(basename "$db")
  sqlite3 "$db" ".backup '$BACKUP_DIR/${BASENAME}_${DATE}'"
  echo "Backed up: $BASENAME"
done

# Keep last 14 days
find "$BACKUP_DIR" -name "*.db_*" -mtime +14 -delete

echo "Backup complete: $(date)"
