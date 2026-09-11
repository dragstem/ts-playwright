#!/usr/bin/env bash
# Phase 1 / P1-T05,T06 — rootless Docker for the service user + DOCKER_HOST/socket wiring.
# Run as root (sudo). The runner daemon then runs unprivileged; container-root maps to tsapp.
set -euo pipefail

TSAPP_USER="${TSAPP_USER:-tsapp}"
ENV_FILE="${ENV_FILE:-/opt/ts-playwright/.env}"

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
id "$TSAPP_USER" >/dev/null 2>&1 || { echo "user $TSAPP_USER missing — run 02-host-setup.sh first"; exit 1; }

echo "== subuid/subgid ranges for $TSAPP_USER =="
grep -q "^${TSAPP_USER}:" /etc/subuid || echo "${TSAPP_USER}:100000:65536" >> /etc/subuid
grep -q "^${TSAPP_USER}:" /etc/subgid || echo "${TSAPP_USER}:100000:65536" >> /etc/subgid

echo "== enable lingering (user services without an active login) =="
loginctl enable-linger "$TSAPP_USER"

UID_N="$(id -u "$TSAPP_USER")"
echo "== install + start rootless dockerd as $TSAPP_USER (uid $UID_N) =="
sudo -iu "$TSAPP_USER" env XDG_RUNTIME_DIR="/run/user/${UID_N}" bash -lc '
  set -e
  command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1 || {
    echo "dockerd-rootless-setuptool.sh not found — install docker-ce-rootless-extras"; exit 1; }
  dockerd-rootless-setuptool.sh install --force 2>/dev/null || dockerd-rootless-setuptool.sh install
  systemctl --user enable docker
  systemctl --user start docker
  systemctl --user --no-pager status docker | head -n 5 || true
  mkdir -p ~/.config/docker
  printf "%s\n" "{ \"log-driver\": \"json-file\", \"log-opts\": { \"max-size\": \"10m\", \"max-file\": \"5\" } }" > ~/.config/docker/daemon.json
  systemctl --user restart docker || true
'

SOCK="/run/user/${UID_N}/docker.sock"
echo "Rootless socket: $SOCK"
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^ROOTLESS_DOCKER_SOCK=' "$ENV_FILE"; then
    sed -i "s#^ROOTLESS_DOCKER_SOCK=.*#ROOTLESS_DOCKER_SOCK=${SOCK}#" "$ENV_FILE"
  else
    echo "ROOTLESS_DOCKER_SOCK=${SOCK}" >> "$ENV_FILE"
  fi
  echo "Set ROOTLESS_DOCKER_SOCK in $ENV_FILE"
else
  echo "NOTE: add to your .env -> ROOTLESS_DOCKER_SOCK=${SOCK}"
fi

echo
echo "Verify rootless daemon:"
echo "  sudo -iu ${TSAPP_USER} DOCKER_HOST=unix://${SOCK} docker version"
echo "Load/build images against THIS daemon (run 04-images.sh as ${TSAPP_USER})."
