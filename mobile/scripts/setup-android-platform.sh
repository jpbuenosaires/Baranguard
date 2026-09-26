#!/usr/bin/env bash
# Baranguard — automates mobile/README.md's "Not done yet" step: add the
# Android platform, install deps, sync. Same conventions as
# backend/scripts/bootstrap-db.sh: idempotent, pass/fail-per-step,
# refuses/skips rather than corrupting existing state.
#
# Usage (from a Git Bash prompt, repo root or mobile/):
#   bash mobile/scripts/setup-android-platform.sh
#
# Does NOT install Android Studio/the SDK itself — that's a large GUI
# installer with license-acceptance prompts, genuinely not scriptable.
# Get it from https://developer.android.com/studio first; this script
# just checks it's there before touching anything.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE_DIR="$REPO_ROOT/mobile"

pass() { echo "[OK]   $1"; }
info() { echo "[INFO] $1"; }
fail() { echo "[FAIL] $1"; }
step() { echo; echo "=== $1 ==="; }

echo "Baranguard mobile Android platform setup — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

step "0. Locate the Android SDK"
SDK_PATH="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK_PATH" ]; then
  # docs/REFERENCE.md §8's own documented default install location.
  DEFAULT_SDK="$USERPROFILE/AppData/Local/Android/Sdk"
  if [ -d "$DEFAULT_SDK" ]; then
    SDK_PATH="$DEFAULT_SDK"
  fi
fi
if [ -z "$SDK_PATH" ] || [ ! -d "$SDK_PATH" ]; then
  fail "No Android SDK found (checked \$ANDROID_HOME, \$ANDROID_SDK_ROOT, and the default Android Studio install path)."
  echo "Install Android Studio first: https://developer.android.com/studio"
  echo "Then either let its installer set ANDROID_HOME, or export it yourself:"
  echo "  export ANDROID_HOME=\"\$USERPROFILE/AppData/Local/Android/Sdk\""
  exit 1
fi
pass "Android SDK found at $SDK_PATH"

step "1. Install mobile/ npm dependencies"
if [ ! -d "$MOBILE_DIR/node_modules" ]; then
  (cd "$MOBILE_DIR" && npm install) || { fail "npm install failed"; exit 1; }
  pass "npm install complete"
else
  info "mobile/node_modules already exists — skipping npm install (run it yourself if package.json changed)"
fi

step "2. Add the Android platform (or confirm it's already added)"
if [ -d "$MOBILE_DIR/android" ]; then
  info "mobile/android/ already exists — skipping 'npx cap add android' (this repo's own history has added/rebuilt it multiple times already, see backend/DEVLOG.md)"
else
  (cd "$MOBILE_DIR" && npx cap add android) || { fail "npx cap add android failed"; exit 1; }
  pass "Android platform added at mobile/android/"
fi

step "3. Sync web assets + plugins into the native project"
(cd "$MOBILE_DIR" && npx cap sync android) || { fail "npx cap sync android failed"; exit 1; }
pass "npx cap sync android complete"

echo
echo "=== Summary ==="
echo "Android SDK:    $SDK_PATH"
echo "mobile/android: $([ -d "$MOBILE_DIR/android" ] && echo present || echo MISSING)"
echo
echo "Next: build a debug APK (needs JAVA_HOME set — see docs/REFERENCE.md §8 for"
echo "the Gradle/JAVA_HOME gotcha with a space in the Windows username):"
echo "  cd mobile/android"
echo "  export JAVA_HOME=\"C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot\""
echo "  export TMPDIR=C:/gtmp TEMP=C:/gtmp TMP=C:/gtmp"
echo "  ./gradlew --stop && ./gradlew assembleDebug"
echo "  adb install -r app/build/outputs/apk/debug/app-debug.apk"
