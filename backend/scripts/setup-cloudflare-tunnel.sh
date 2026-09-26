#!/usr/bin/env bash
# Baranguard — turns the manual Cloudflare Named Tunnel sequence (tunnel
# create, hand-writing config.yml, two DNS routes) into one idempotent
# script. This is the real, persistent remote-access mechanism (C-03),
# not the Cloudflare Quick Tunnel — see docs/REFERENCE.md §1 for the
# distinction (Quick Tunnel is a random-hostname, no-auth, testing-only
# exception; this is the real thing).
#
# PREREQUISITES, all manual/interactive — not scripted, on purpose:
#   1. A Cloudflare account (cloudflare.com — free tier is enough).
#   2. A domain added to that account (Cloudflare Registrar, or any
#      registrar with nameservers pointed at Cloudflare).
#   3. `cloudflared tunnel login` already run once from this machine —
#      it opens a browser for you to authorize, which cannot be scripted.
#
# Usage (from a Git Bash prompt):
#   bash backend/scripts/setup-cloudflare-tunnel.sh baranguardph.win
# or omit the argument and it will prompt for the domain:
#   bash backend/scripts/setup-cloudflare-tunnel.sh
#
# Safe to re-run: skips tunnel creation if one with this name already
# exists, and tolerates "route already exists" as success rather than an
# error — re-running after a partial failure (or just to double-check)
# won't create duplicates or break anything.

set -uo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-baranguard}"

pass() { echo "[OK]   $1"; }
info() { echo "[INFO] $1"; }
fail() { echo "[FAIL] $1"; }
step() { echo; echo "=== $1 ==="; }

echo "Baranguard Cloudflare Named Tunnel setup — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if ! command -v cloudflared >/dev/null 2>&1; then
  fail "cloudflared not found on PATH. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

step "0. Domain to route through this tunnel"
BASE_HOSTNAME="${1:-}"
if [ -z "$BASE_HOSTNAME" ]; then
  read -r -p "Domain registered in Cloudflare (e.g. baranguardph.win): " BASE_HOSTNAME
fi
if [ -z "$BASE_HOSTNAME" ]; then
  fail "No domain given — nothing to do."
  exit 1
fi
API_HOSTNAME="api.${BASE_HOSTNAME}"
pass "Web:  https://$BASE_HOSTNAME"
pass "API:  https://$API_HOSTNAME"

step "1. Confirm cloudflared is authenticated"
CERT_PATH="$HOME/.cloudflared/cert.pem"
if [ ! -f "$CERT_PATH" ]; then
  fail "No $CERT_PATH found — run 'cloudflared tunnel login' first (opens a browser to authorize against your Cloudflare account; this step can't be scripted)."
  exit 1
fi
pass "Found existing Cloudflare authorization at $CERT_PATH"

step "2. Create the tunnel (or reuse an existing one)"
# Plain-text list output is more portable across cloudflared versions
# than relying on --output json parsing here; grep the name column.
EXISTING_LINE="$(cloudflared tunnel list 2>/dev/null | grep -E "[[:space:]]${TUNNEL_NAME}[[:space:]]" || true)"
if [ -n "$EXISTING_LINE" ]; then
  TUNNEL_ID="$(echo "$EXISTING_LINE" | awk '{print $1}')"
  pass "Tunnel '$TUNNEL_NAME' already exists (id $TUNNEL_ID) — reusing it"
else
  CREATE_OUT="$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)"
  echo "$CREATE_OUT"
  TUNNEL_ID="$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  if [ -z "$TUNNEL_ID" ]; then
    fail "Could not parse a tunnel id out of 'cloudflared tunnel create' output — see above."
    exit 1
  fi
  pass "Created tunnel '$TUNNEL_NAME' (id $TUNNEL_ID)"
fi

step "3. Write ~/.cloudflared/config.yml"
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"
mkdir -p "$CONFIG_DIR"
CRED_FILE_WIN="$(cygpath -w "$CONFIG_DIR/${TUNNEL_ID}.json" 2>/dev/null || echo "$CONFIG_DIR/${TUNNEL_ID}.json")"

if [ -f "$CONFIG_FILE" ] && grep -q "tunnel: $TUNNEL_ID" "$CONFIG_FILE" 2>/dev/null && grep -q "$BASE_HOSTNAME" "$CONFIG_FILE" 2>/dev/null; then
  info "$CONFIG_FILE already routes tunnel $TUNNEL_ID to $BASE_HOSTNAME — leaving it as-is"
else
  cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CRED_FILE_WIN

ingress:
  - hostname: $BASE_HOSTNAME
    service: http://localhost:80
  - hostname: $API_HOSTNAME
    service: http://localhost:8081
  - service: http_status:404
EOF
  pass "Wrote $CONFIG_FILE"
fi

step "4. Route DNS for both hostnames"
for host in "$BASE_HOSTNAME" "$API_HOSTNAME"; do
  ROUTE_OUT="$(cloudflared tunnel route dns "$TUNNEL_NAME" "$host" 2>&1)"
  if echo "$ROUTE_OUT" | grep -qi "error\|failed"; then
    if echo "$ROUTE_OUT" | grep -qi "already"; then
      info "$host already routed to this tunnel"
    else
      fail "Routing $host failed: $ROUTE_OUT"
    fi
  else
    pass "Routed $host -> tunnel $TUNNEL_NAME"
  fi
done

step "5. Start the tunnel and verify"
info "Run this to start it now (foreground, Ctrl+C to stop):"
echo "    cloudflared tunnel run $TUNNEL_NAME"
info "Or, for it to survive a reboot: backend/scripts/install-autostart-services.ps1 (from an elevated prompt)"
echo
echo "Once running, verify with:"
echo "    curl -s -o /dev/null -w 'web: %{http_code}\\n' https://$BASE_HOSTNAME/baranguard/web/"
echo "    curl -s -o /dev/null -w 'api: %{http_code}\\n' https://$API_HOSTNAME/api/v1/barangays"
echo
echo "Also add https://$BASE_HOSTNAME to backend/.env's CORS_ALLOWED_ORIGIN if it isn't already there."
