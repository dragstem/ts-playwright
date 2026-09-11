#!/usr/bin/env bash
# Phase 1 / P1-T02,T03,T04 — base OS, time sync (NTP), Docker engine, service user, log rotation.
# Run as root (sudo). Safe to re-run.
set -euo pipefail

TIMEZONE="${TIMEZONE:-Europe/Riga}"
TSAPP_USER="${TSAPP_USER:-tsapp}"

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }

echo "== apt: update + base packages =="
apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl git ufw chrony jq \
  uidmap dbus-user-session slirp4netns fuse-overlayfs

echo "== timezone + NTP (CRITICAL for TOTP / stand 2FA) =="
timedatectl set-timezone "$TIMEZONE"
timedatectl set-ntp true
timedatectl show -p NTPSynchronized || true
chronyc tracking 2>/dev/null | grep -i 'system time' || true

echo "== cgroups v2 (needed for rootless cpu/memory/pids limits) =="
if [[ "$(stat -fc %T /sys/fs/cgroup)" == "cgroup2fs" ]]; then
  echo "cgroups v2: OK"
else
  echo "WARNING: cgroups v1 — --cpus/--memory may not apply under rootless Docker." >&2
fi

echo "== Docker Engine + rootless extras =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "docker present: $(docker --version)"
fi
apt-get -y install docker-ce-rootless-extras 2>/dev/null || \
  echo "NOTE: docker-ce-rootless-extras not from apt (get.docker.com bundles it) — continuing."

echo "== service user '$TSAPP_USER' =="
id "$TSAPP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$TSAPP_USER"
id "$TSAPP_USER"

echo "== rootful Docker log rotation (P1-T04) =="
install -d -m 0755 /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
JSON
  systemctl restart docker || true
  echo "wrote /etc/docker/daemon.json"
else
  echo "daemon.json exists — review log-opts manually (left unchanged)."
fi

echo
echo "Done. Next: 03-rootless-docker.sh (sets up the unprivileged runner daemon)."
