#!/usr/bin/env bash
# Shared helpers for talking to a local Zitadel via curl + jq.
#
# Expected env:
#   ZITADEL_BASE        e.g. http://localhost:8080
#   ZITADEL_PAT         admin-machine PAT (Bearer token)
#   UNTENANTED_BASE     base URL of the Untenanted API (e.g. http://localhost:3000)
# Optional:
#   STATE_DIR           dir to persist created IDs (default: ./.state)

set -euo pipefail

: "${ZITADEL_BASE:?ZITADEL_BASE is required}"
: "${ZITADEL_PAT:?ZITADEL_PAT is required}"
: "${UNTENANTED_BASE:=http://localhost:3000}"
STATE_DIR="${STATE_DIR:-$(dirname "$0")/../.state}"
mkdir -p "$STATE_DIR"

# Bypass any local curl wrapper (some setups proxy curl via a token-pruning tool).
CURL_BIN="$(command -v rtk >/dev/null 2>&1 && echo "rtk proxy curl" || echo curl)"

zcurl() {
  $CURL_BIN -sS \
    -H "Authorization: Bearer $ZITADEL_PAT" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@"
}

ucurl() {
  $CURL_BIN -sS \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    "$@"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
}

# Persist a key=value pair to STATE_DIR/state.env for later steps.
remember() {
  local key="$1" value="$2"
  local file="$STATE_DIR/state.env"
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file" && rm -f "${file}.bak"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

load_state() {
  local file="$STATE_DIR/state.env"
  [[ -f "$file" ]] && set -a && . "$file" && set +a || true
}
