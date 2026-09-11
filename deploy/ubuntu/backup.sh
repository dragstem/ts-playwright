#!/usr/bin/env bash
# Phase 1 / P1-T15 — back up the storage volume with rotation. Run as the rootless user (tsapp).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/ts-playwright/backups}"
KEEP="${KEEP:-14}"
VOLUME="${VOLUME:-ts-playwright-storage}"   # fixed name (see docker-compose.yml volumes.name)
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
docker run --rm -v "${VOLUME}:/data:ro" -v "${BACKUP_DIR}:/backup" alpine \
  sh -c "cd /data && tar czf /backup/storage-${STAMP}.tar.gz ."

# Rotate: keep the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/storage-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "Backup written: $BACKUP_DIR/storage-${STAMP}.tar.gz (keeping newest $KEEP)"

# Phase 2 reminder: back up the encryption KEK SEPARATELY (offline/KMS). Never store the KEK
# inside this archive — a backup holding both ciphertext and key defeats encryption-at-rest.
