#!/usr/bin/env bash
# Fresh-deploy verification + single-instance observation for the Fly.io
# deploy template (WS-47, SC-07 + SC-12). See deploy/README.md §6.
#
# Usage:
#   ./deploy/verify-deploy.sh health <base-url>
#   ./deploy/verify-deploy.sh smoke  <base-url> <api-key> <agent-name>
#   ./deploy/verify-deploy.sh observe <fly-app-name> <base-url> [duration-s]
#
#   health  — poll GET /health until ok (bounded, 120s).
#   smoke   — bounded streaming smoke via the repo harness: session create →
#             WebSocket → streamed turn (operator-provisioned key + agent,
#             NOT the WS-43 dev bootstrap).
#   observe — the SC-12 loop: while a rolling deploy or a restart happens in
#             another terminal, samples `fly machines list --json` and the
#             serving path once per second; FAILS if >1 machine is ever in
#             state "started", and reports the serving identity per sample.
#             Run it across (a) a `fly deploy` and (b) a `fly machine
#             restart`, and capture the output as evidence. Configuration
#             values alone are explicitly insufficient for SC-12.
set -euo pipefail

cmd="${1:-}"; shift || true

case "$cmd" in
  health)
    base="${1:?usage: verify-deploy.sh health <base-url>}"
    echo "polling $base/health (bounded 120s)…"
    for i in $(seq 1 60); do
      if out=$(curl -fsS --max-time 5 "$base/health" 2>/dev/null); then
        echo "health ok after $((i*2))s: $out"
        exit 0
      fi
      sleep 2
    done
    echo "FAIL: /health did not go green within 120s" >&2
    exit 1
    ;;

  smoke)
    base="${1:?usage: verify-deploy.sh smoke <base-url> <api-key> <agent>}"
    key="${2:?api key required}"
    agent="${3:?agent name required}"
    echo "running bounded streaming smoke against $base (agent: $agent)…"
    SMOKE_BASE_URL="$base" SMOKE_API_KEY="$key" SMOKE_AGENT_NAME="$agent" \
      pnpm smoke:realtime
    ;;

  observe)
    app="${1:?usage: verify-deploy.sh observe <fly-app> <base-url> [secs]}"
    base="${2:?base url required}"
    dur="${3:-180}"
    echo "observing app=$app for ${dur}s — start your deploy/restart now."
    echo "ts | started-machines | ids | serving"
    fail=0
    end=$(( $(date +%s) + dur ))
    while [ "$(date +%s)" -lt "$end" ]; do
      ts=$(date -u +%H:%M:%S)
      json=$(fly machines list -a "$app" --json 2>/dev/null || echo '[]')
      started=$(echo "$json" | jq '[.[] | select(.state=="started")] | length')
      ids=$(echo "$json" | jq -r '[.[] | select(.state=="started") | .id] | join(",")')
      serving=$(curl -fsS --max-time 3 "$base/health" >/dev/null 2>&1 && echo up || echo down)
      echo "$ts | $started | ${ids:-none} | $serving"
      if [ "${started:-0}" -gt 1 ]; then
        echo "FAIL: $started machines in state=started at $ts ($ids)" >&2
        fail=1
      fi
      sleep 1
    done
    if [ "$fail" -eq 1 ]; then
      echo "OBSERVATION FAILED: more than one serving instance was observed." >&2
      exit 1
    fi
    echo "OBSERVATION PASSED: at no sample point did two machines serve."
    ;;

  *)
    echo "usage: verify-deploy.sh {health|smoke|observe} …" >&2
    exit 2
    ;;
esac
