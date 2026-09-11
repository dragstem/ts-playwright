#!/usr/bin/env bash
# Phase 1 / P1-T13 — ufw: default deny incoming, allow SSH (allowlist) + 80/443. Run as root.
# Never publish container port 8000 — only Caddy (443) faces the network.
set -euo pipefail

ADMIN_CIDR="${ADMIN_CIDR:-}"   # e.g. 203.0.113.10/32 — empty allows SSH from anywhere (less safe)

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$ADMIN_CIDR" ]]; then
  ufw allow from "$ADMIN_CIDR" to any port 22 proto tcp
else
  echo "WARNING: ADMIN_CIDR not set — allowing SSH from anywhere." >&2
  ufw allow 22/tcp
fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo
echo "NOTE: Docker can bypass ufw via iptables when ports are PUBLISHED. The compose here"
echo "      does NOT publish 8000, so the server stays internal. Keep it that way."
