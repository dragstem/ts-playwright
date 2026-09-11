#!/usr/bin/env bash
# Phase 1 / P1-T19 — update to a new image tag with a /health gate; records the previous tag.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/ts-playwright}"
NEW_IMAGE="${1:?usage: update.sh <new-image-tag>}"
cd "$COMPOSE_DIR"

PREV_IMAGE="$(grep -E '^TS_PLAYWRIGHT_IMAGE=' .env | cut -d= -f2-)"
echo "$PREV_IMAGE" > .last-image
echo "Previous image saved: $PREV_IMAGE"

echo "Backing up storage before update..."
./backup.sh || echo "WARN: backup failed — continuing (review before relying on rollback)."

sed -i "s#^TS_PLAYWRIGHT_IMAGE=.*#TS_PLAYWRIGHT_IMAGE=${NEW_IMAGE}#" .env
docker compose up -d ts-playwright-server

echo "Waiting for /health ..."
for _ in $(seq 1 30); do
  if docker compose exec -T ts-playwright-server \
      node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "Healthy. Update to ${NEW_IMAGE} complete."
    exit 0
  fi
  sleep 2
done

echo "New image did not become healthy in time — run ./rollback.sh" >&2
exit 1
