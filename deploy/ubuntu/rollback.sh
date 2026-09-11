#!/usr/bin/env bash
# Phase 1 / P1-T19 — roll back to the previously recorded image tag.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/ts-playwright}"
cd "$COMPOSE_DIR"

PREV="$(cat .last-image 2>/dev/null || true)"
[[ -n "$PREV" ]] || { echo "no .last-image recorded — nothing to roll back to"; exit 1; }

sed -i "s#^TS_PLAYWRIGHT_IMAGE=.*#TS_PLAYWRIGHT_IMAGE=${PREV}#" .env
docker compose up -d ts-playwright-server
echo "Rolled back to ${PREV}."
echo "If the storage volume itself is corrupt, restore the newest archive from ./backups/."
