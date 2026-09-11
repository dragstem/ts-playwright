#!/usr/bin/env bash
# Phase 1 / P1-T16 — reclaim space: exited runner containers + dangling images.
# Run as the rootless user (tsapp), or with DOCKER_HOST set to the rootless socket.
set -euo pipefail

docker container prune -f --filter "until=24h" || true
docker image prune -f || true
echo "Pruned exited containers (>24h) and dangling images."

# Run-artifact retention (trace/video) is enforced inside the app starting in Phase 3.
# Until then, old run artifacts live under the storage volume and are covered by backups.
