#!/usr/bin/env bash
# Phase 1 / P1-T01 — PRE-FLIGHT BLOCKER.
# Verify every test stand BASE_URL is reachable BOTH from this host and from inside a
# runner container. If a stand is only visible from the operator's network/VPN, the headless
# runner on this PC will not reach it and runs will fail — fix the network before deploying.
#
# Usage:
#   ./01-preflight-reachability.sh https://stand-a.example https://stand-b.example
#   ./01-preflight-reachability.sh -f urls.txt        # one URL per line, '#' comments allowed
#
# Env: RUNNER_IMAGE (default mcr.microsoft.com/playwright:v1.52.0-jammy), TIMEOUT (default 10).
set -euo pipefail

RUNNER_IMAGE="${RUNNER_IMAGE:-mcr.microsoft.com/playwright:v1.52.0-jammy}"
TIMEOUT="${TIMEOUT:-10}"

urls=()
if [[ "${1:-}" == "-f" ]]; then
  [[ -f "${2:-}" ]] || { echo "file not found: ${2:-}" >&2; exit 2; }
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs || true)"
    [[ -n "$line" ]] && urls+=("$line")
  done < "$2"
else
  urls=("$@")
fi
[[ ${#urls[@]} -gt 0 ]] || { echo "No URLs given. See header for usage." >&2; exit 2; }

probe_host() {
  curl -ksS -o /dev/null -m "$TIMEOUT" -w '%{http_code} %{time_total}s' "$1" 2>/dev/null || echo "FAIL -"
}
probe_container() {
  docker run --rm --network "${APP_DOCKER_NETWORK:-bridge}" "$RUNNER_IMAGE" \
    curl -ksS -o /dev/null -m "$TIMEOUT" -w '%{http_code} %{time_total}s' "$1" 2>/dev/null || echo "FAIL -"
}

printf '%-45s | %-18s | %-18s\n' "BASE_URL" "from host" "from container"
printf '%-45s-+-%-18s-+-%-18s\n' "---------------------------------------------" "------------------" "------------------"
rc=0
for u in "${urls[@]}"; do
  h="$(probe_host "$u")"
  c="$(probe_container "$u")"
  printf '%-45s | %-18s | %-18s\n' "$u" "$h" "$c"
  case "$h $c" in *FAIL*|*"000 "*) rc=1;; esac
done

echo
if [[ $rc -ne 0 ]]; then
  echo "RESULT: at least one stand is NOT reachable from host and/or container." >&2
  echo "Fix before deploying: put this PC on the stands' network, or run the same VPN/WireGuard here." >&2
else
  echo "RESULT: all stands reachable from both host and container."
fi
exit $rc
