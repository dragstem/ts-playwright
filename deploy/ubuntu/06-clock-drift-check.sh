#!/usr/bin/env bash
# Phase 1 / P1-T17 — NTP/clock drift guard. Clock drift silently breaks stand 2FA (TOTP):
# the test fails as `failed`, not `error`, so this is worth alerting on. Run from cron/monitoring.
# Exits non-zero (and prints ALERT) when |offset| exceeds THRESHOLD_S seconds.
set -euo pipefail

THRESHOLD_S="${THRESHOLD_S:-1.0}"

synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo "unknown")"
offset="$(chronyc tracking 2>/dev/null | awk -F'[: ]+' '/System time/ {print $4}')"
offset="${offset:-0}"

awk -v o="$offset" -v t="$THRESHOLD_S" -v s="$synced" 'BEGIN{
  abs = (o<0)? -o : o;
  printf "NTPSynchronized=%s offset=%ss threshold=%ss\n", s, o, t;
  if (s != "yes") { print "ALERT: clock is NOT NTP-synchronized — stand 2FA may drift."; exit 1 }
  if (abs > t)    { printf "ALERT: clock offset %ss exceeds %ss — stand 2FA may drift.\n", o, t; exit 1 }
  print "OK: clock within threshold.";
}'
