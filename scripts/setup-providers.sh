#!/usr/bin/env bash
# =============================================================================
# setup-providers.sh - wire .env.providers into the OmniRoute DB
#
# Reads /home/jferm/OmniRoute/.env.providers and PUTs each connection via
# the local OmniRoute management API, then clears test_status=expired so
# the combo stops rejecting them.
#
# Usage:
#   1. Fill in CLOUDFLARE_NN_API_TOKEN values in .env.providers
#   2. Make sure your dashboard password is set in INITIAL_PASSWORD env var
#      (or pass it as the first arg)
#   3. ./scripts/setup-providers.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.providers"
BASE_URL="${OMNIROUTE_BASE_URL:-http://localhost:20128}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Login
PASSWORD="${1:-${INITIAL_PASSWORD:-}}"
if [[ -z "$PASSWORD" ]]; then
  echo "ERROR: No password. Pass it as arg or set INITIAL_PASSWORD."
  exit 1
fi

COOKIES=$(mktemp)
trap "rm -f $COOKIES" EXIT

echo "==> Logging in to $BASE_URL..."
curl -s -c "$COOKIES" -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" > /dev/null

# Map CF account number -> connection_id
echo "==> Looking up connection IDs..."
CF_IDS=$(sqlite3 /home/jferm/.omniroute/storage.sqlite \
  "SELECT name, id FROM provider_connections
   WHERE provider = 'cloudflare-ai' AND name LIKE 'cloudflare-ai-%' ORDER BY name;")
NV_IDS=$(sqlite3 /home/jferm/.omniroute/storage.sqlite \
  "SELECT name, id FROM provider_connections
   WHERE provider = 'nvidia' ORDER BY name;")

# Update CF connections
echo "$CF_IDS" | while IFS='|' read -r name id; do
  num="${name#cloudflare-ai-}"
  key_var="CLOUDFLARE_$(printf '%02d' $num)_API_TOKEN"
  token="${!key_var:-}"
  if [[ -z "$token" || "$token" == "__REPLACE_ME__" ]]; then
    echo "  [skip] $name - no token set in .env.providers ($key_var)"
    continue
  fi
  echo "  [update] $name ($id) - setting apiKey + clearing test_status..."
  curl -s -b "$COOKIES" -X PUT "$BASE_URL/api/providers/$id" \
    -H "Content-Type: application/json" \
    -d "{\"apiKey\":\"$token\",\"testStatus\":\"active\",\"lastError\":null,\"lastErrorAt\":null,\"errorCode\":null}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('   ', d.get('name'), '->', d.get('testStatus'))" 2>/dev/null || echo "    (response parse failed)"
done

# Update NVIDIA connections
echo "$NV_IDS" | while IFS='|' read -r name id; do
  num="${name#nvidia-}"
  key_var="NVIDIA_${num}_API_KEY"
  token="${!key_var:-}"
  if [[ -z "$token" || "$token" == "__REPLACE_ME__" ]]; then
    echo "  [skip] $name - no key set in .env.providers ($key_var)"
    continue
  fi
  echo "  [update] $name ($id) - key already rotated earlier via API; re-applying..."
  curl -s -b "$COOKIES" -X PUT "$BASE_URL/api/providers/$id" \
    -H "Content-Type: application/json" \
    -d "{\"apiKey\":\"$token\",\"testStatus\":\"active\",\"lastError\":null,\"lastErrorAt\":null,\"errorCode\":null}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('   ', d.get('name'), '->', d.get('testStatus'))" 2>/dev/null || echo "    (response parse failed)"
done

echo ""
echo "==> Done. Test each connection:"
echo "    curl -b $COOKIES $BASE_URL/api/rate-limits | jq '.connections[] | {name, testStatus: .active}'"
echo ""
echo "==> Active combo (should be the outer combo):"
sqlite3 /home/jferm/.omniroute/storage.sqlite \
  "SELECT value FROM key_value WHERE key='activeCombo';"