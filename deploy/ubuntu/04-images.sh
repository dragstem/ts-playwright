#!/usr/bin/env bash
# Phase 1 / P1-T09 — build server + pinned runner images locally, or move them offline.
# Pins Playwright 1.52.0 and enables RUNNER_MODE=global (no outbound npm at run time).
# Run AS the rootless user (tsapp) so images land in the rootless daemon used at run time.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SERVER_TAG="${SERVER_TAG:-ts-playwright/server:local}"
RUNNER_TAG="${RUNNER_TAG:-ts-playwright/runner:1.52.0}"
OUT_DIR="${OUT_DIR:-./images}"
mode="${1:-build}"

case "$mode" in
  build)
    docker build -t "$SERVER_TAG" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
    docker build -t "$RUNNER_TAG" -f "$REPO_ROOT/Dockerfile.runner" "$REPO_ROOT"
    echo "Built $SERVER_TAG and $RUNNER_TAG"
    echo "Set in .env:  TS_PLAYWRIGHT_IMAGE=$SERVER_TAG  APP_DOCKER_IMAGE=$RUNNER_TAG  APP_DOCKER_RUNNER_MODE=global"
    ;;
  save)
    mkdir -p "$OUT_DIR"
    docker save "$SERVER_TAG" | gzip > "$OUT_DIR/server.tar.gz"
    docker save "$RUNNER_TAG" | gzip > "$OUT_DIR/runner.tar.gz"
    echo "Saved to $OUT_DIR — copy to the air-gapped host, then run: $0 load"
    ;;
  load)
    gunzip -c "$OUT_DIR/server.tar.gz" | docker load
    gunzip -c "$OUT_DIR/runner.tar.gz" | docker load
    echo "Loaded server + runner images into this (rootless) daemon."
    ;;
  *)
    echo "usage: $0 {build|save|load}"; exit 2 ;;
esac
