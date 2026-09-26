#!/usr/bin/env bash
# Baranguard — interactive backend/.env generator for a FRESH machine.
#
# Replaces docs/SETUP.md's old manual sequence ("copy .env.example, hand-
# generate 3 secrets with php -r, paste the DB_* values bootstrap-db.sh
# printed") with one script. Same conventions as bootstrap-db.sh: refuses
# to touch existing state, prints a pass/fail/info line per step, safe to
# re-run only after removing/renaming a previous attempt.
#
# Usage (from a Git Bash prompt, repo root or anywhere):
#   bash backend/scripts/setup-env.sh
#
# Chains cleanly after bootstrap-db.sh — pipe its printed DB_* values in
# as env vars and this script won't re-ask for them:
#   DB_NAME=baranguard DB_USER=baranguard_app DB_PASSWORD='...' \
#     bash backend/scripts/setup-env.sh
#
# For scripting/CI use (or anyone who just wants the secrets generated
# and every optional integration left blank, no prompts at all):
#   bash backend/scripts/setup-env.sh --non-interactive
#
# Optional-integration values can also be pre-set as env vars to skip
# their individual prompt: ORS_API_KEY, FCM_SERVICE_ACCOUNT_PATH,
# GSM_GATEWAY_ENABLED (true/false).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
ENV_FILE="$BACKEND_DIR/.env"
ENV_EXAMPLE="$BACKEND_DIR/.env.example"

INFO=0
pass() { echo "[OK]   $1"; }
info() { echo "[INFO] $1"; INFO=$((INFO+1)); }
fail() { echo "[FAIL] $1"; }
step() { echo; echo "=== $1 ==="; }

NON_INTERACTIVE=0
for arg in "$@"; do
  [ "$arg" = "--non-interactive" ] && NON_INTERACTIVE=1
done

PHP_BIN="php"
command -v php >/dev/null 2>&1 || PHP_BIN="/c/xampp/php/php.exe"
if ! "$PHP_BIN" -v >/dev/null 2>&1; then
  echo "ERROR: php not found on PATH or at C:\\xampp\\php\\php.exe." >&2
  exit 1
fi

# Prompts only when interactive AND the caller didn't already supply the
# value as an env var — same "env var wins" precedent config/env.php
# itself already documents (CLAUDE.md §8), applied to this script's own
# inputs instead of PHP's runtime config.
ask() {
  local varname="$1" prompt="$2" default="${3:-}"
  local current="${!varname:-}"
  if [ -n "$current" ]; then
    echo "$varname (from environment): ${current}"
    return
  fi
  if [ "$NON_INTERACTIVE" = "1" ]; then
    printf -v "$varname" '%s' "$default"
    return
  fi
  local reply
  read -r -p "$prompt" reply
  printf -v "$varname" '%s' "${reply:-$default}"
}

ask_yes_no() {
  local prompt="$1" default="${2:-N}"
  if [ "$NON_INTERACTIVE" = "1" ]; then
    [ "$default" = "Y" ] && return 0 || return 1
  fi
  local reply
  read -r -p "$prompt" reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

echo "Baranguard backend/.env setup — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

step "0. Refuse to overwrite an existing .env"
if [ -f "$ENV_FILE" ]; then
  fail "backend/.env already exists — refusing to touch it."
  echo "If you really want to regenerate it, move it aside first:"
  echo "  mv backend/.env backend/.env.bak"
  exit 1
fi
if [ ! -f "$ENV_EXAMPLE" ]; then
  fail "backend/.env.example not found — is this the repo root?"
  exit 1
fi
pass "backend/.env does not exist yet — safe to create"

step "1. Database credentials"
ask DB_NAME "DB_NAME [baranguard]: " "baranguard"
ask DB_USER "DB_USER [baranguard_app]: " "baranguard_app"
ask DB_PASSWORD "DB_PASSWORD (from bootstrap-db.sh's printed output): " ""
if [ -z "$DB_PASSWORD" ]; then
  fail "DB_PASSWORD is empty — config/env.php rejects an empty password by design (CLAUDE.md §8). Run backend/scripts/bootstrap-db.sh first and pass its printed DB_PASSWORD here."
  exit 1
fi
pass "DB_NAME=$DB_NAME DB_USER=$DB_USER (password captured, not echoed again)"

step "2. Auto-generating the three required secrets"
JWT_SECRET="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
INTERNAL_SERVICE_TOKEN="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
DEVICE_SECRET_MASTER_KEY="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(32));')"
pass "JWT_SECRET generated (32 random bytes, hex)"
pass "INTERNAL_SERVICE_TOKEN generated (32 random bytes, hex)"
pass "DEVICE_SECRET_MASTER_KEY generated (32 random bytes, hex)"

step "3. Optional integrations — each defaults to 'not configured' if you skip it"

ORS_API_KEY="${ORS_API_KEY:-}"
if [ -z "$ORS_API_KEY" ]; then
  if ask_yes_no "Set up turn-by-turn routing now? Have an OpenRouteService API key? [y/N]: " "N"; then
    ask ORS_API_KEY "ORS_API_KEY: " ""
  fi
fi
if [ -n "$ORS_API_KEY" ]; then pass "ORS_API_KEY set"; else info "ORS_API_KEY left blank — GET /system/health will report ors: not_configured (honest, not broken)"; fi

FCM_SERVICE_ACCOUNT_PATH="${FCM_SERVICE_ACCOUNT_PATH:-}"
if [ -z "$FCM_SERVICE_ACCOUNT_PATH" ]; then
  if ask_yes_no "Set up push notifications now? Have a Firebase service-account JSON key file? [y/N]: " "N"; then
    ask FCM_SERVICE_ACCOUNT_PATH "Path to the service-account JSON file: " ""
    if [ -n "$FCM_SERVICE_ACCOUNT_PATH" ] && [ ! -f "$FCM_SERVICE_ACCOUNT_PATH" ]; then
      fail "File not found at '$FCM_SERVICE_ACCOUNT_PATH' — leaving FCM_SERVICE_ACCOUNT_PATH blank rather than writing a broken path."
      FCM_SERVICE_ACCOUNT_PATH=""
    fi
  fi
fi
if [ -n "$FCM_SERVICE_ACCOUNT_PATH" ]; then pass "FCM_SERVICE_ACCOUNT_PATH set (file confirmed to exist)"; else info "FCM_SERVICE_ACCOUNT_PATH left blank — notifications fall straight to SMS, GET /system/health reports fcm: not_configured"; fi

GSM_GATEWAY_ENABLED="${GSM_GATEWAY_ENABLED:-}"
if [ -z "$GSM_GATEWAY_ENABLED" ]; then
  if ask_yes_no "Enable the local GSM SMS gateway now? Only say yes if the gateway phone is already set up per sms-gateway/README.md. [y/N]: " "N"; then
    GSM_GATEWAY_ENABLED="true"
  else
    GSM_GATEWAY_ENABLED="false"
  fi
fi
if [ "$GSM_GATEWAY_ENABLED" = "true" ]; then pass "GSM_GATEWAY_ENABLED=true"; else info "GSM_GATEWAY_ENABLED=false — come back to this once sms-gateway/README.md's setup is done"; fi

step "4. Writing backend/.env"
cp "$ENV_EXAMPLE" "$ENV_FILE"

# In-place substitution, one field at a time — each of these keys appears
# exactly once in .env.example, as a bare `KEY=` line.
set_env_value() {
  local key="$1" value="$2"
  # Escape & and \ for sed's replacement side; the values here are all
  # hex/paths/booleans, never containing a literal newline.
  local escaped
  escaped=$(printf '%s' "$value" | sed -e 's/[&\\]/\\&/g')
  sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
}

set_env_value "DB_NAME" "$DB_NAME"
set_env_value "DB_USER" "$DB_USER"
set_env_value "DB_PASSWORD" "$DB_PASSWORD"
set_env_value "JWT_SECRET" "$JWT_SECRET"
set_env_value "INTERNAL_SERVICE_TOKEN" "$INTERNAL_SERVICE_TOKEN"
set_env_value "DEVICE_SECRET_MASTER_KEY" "$DEVICE_SECRET_MASTER_KEY"
[ -n "$ORS_API_KEY" ] && set_env_value "ORS_API_KEY" "$ORS_API_KEY"
[ -n "$FCM_SERVICE_ACCOUNT_PATH" ] && set_env_value "FCM_SERVICE_ACCOUNT_PATH" "$FCM_SERVICE_ACCOUNT_PATH"
set_env_value "GSM_GATEWAY_ENABLED" "$GSM_GATEWAY_ENABLED"

pass "backend/.env written"

echo
echo "=== Summary ==="
echo "  DB_NAME=$DB_NAME  DB_USER=$DB_USER  DB_PASSWORD=<set>"
echo "  JWT_SECRET / INTERNAL_SERVICE_TOKEN / DEVICE_SECRET_MASTER_KEY: generated"
echo "  ORS_API_KEY:               $([ -n "$ORS_API_KEY" ] && echo set || echo 'blank (not_configured)')"
echo "  FCM_SERVICE_ACCOUNT_PATH:  $([ -n "$FCM_SERVICE_ACCOUNT_PATH" ] && echo set || echo 'blank (not_configured)')"
echo "  GSM_GATEWAY_ENABLED:       $GSM_GATEWAY_ENABLED"
echo
echo "Next: cd backend && npm install && node scripts/bootstrap-admin.js"
