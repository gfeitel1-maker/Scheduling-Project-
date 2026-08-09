#!/usr/bin/env bash
#
# Build Shoresh and update the ALREADY-INSTALLED /Applications/Shoresh.app
# in place, with rollback safety and verify-before-commit.
#
# This is install-macos.sh's sibling for the "already installed, update it"
# case: it reuses the same build + ABI machinery but adds a backup/restore
# swap so a bad build never leaves /Applications without a working app.
#
# Preserves both install-macos.sh gotchas (read that script for the full
# writeup):
#   1. Duplicate LaunchServices registration under the "Applications" dir name.
#   2. `ditto`, not `cp -R`, to install a .app bundle; clear quarantine after.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Shoresh.app"
BUILD_OUTPUT="$PROJECT_DIR/release/mac/$APP_NAME"
INSTALL_PATH="/Applications/$APP_NAME"
BACKUP_PATH="/Applications/$APP_NAME.bak"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

cd "$PROJECT_DIR"

lsregister_fixup() {
  local app_path="$1"
  if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$app_path" 2>/dev/null || true
  fi
}

restore_backup() {
  echo "==> Restoring previous install from backup" >&2
  rm -rf "$INSTALL_PATH"
  mv "$BACKUP_PATH" "$INSTALL_PATH"
  lsregister_fixup "$INSTALL_PATH"
}

echo "==> Checking better-sqlite3 is built for Electron"
if ! node scripts/verifyNativeAbi.js project; then
  echo "==> Rebuilding better-sqlite3 for Electron"
  npx electron-rebuild -f -w better-sqlite3
  node scripts/verifyNativeAbi.js project || {
    echo "ERROR: better-sqlite3 is still not built for Electron after a rebuild." >&2
    exit 1
  }
fi

echo "==> Building (vite build + electron-builder)"
npm run electron:build

if [ ! -d "$BUILD_OUTPUT" ]; then
  echo "ERROR: expected build output at $BUILD_OUTPUT but it does not exist." >&2
  exit 1
fi

EXPECTED_COMMIT="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  EXPECTED_COMMIT="${EXPECTED_COMMIT}-dirty"
fi

HAD_PREVIOUS_INSTALL=0
if [ -d "$INSTALL_PATH" ]; then
  HAD_PREVIOUS_INSTALL=1
  # Keep exactly one backup generation.
  rm -rf "$BACKUP_PATH"
  echo "==> Backing up current install to $BACKUP_PATH"
  mv "$INSTALL_PATH" "$BACKUP_PATH"
fi

echo "==> Installing to $INSTALL_PATH (ditto, not cp -R)"
ditto "$BUILD_OUTPUT" "$INSTALL_PATH"

echo "==> Clearing quarantine (build is unsigned)"
xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true

if [ -x "$LSREGISTER" ]; then
  echo "==> Removing duplicate LaunchServices registration for build output"
  "$LSREGISTER" -u "$BUILD_OUTPUT" 2>/dev/null || true
  echo "==> Registering installed app"
  "$LSREGISTER" -f "$INSTALL_PATH" 2>/dev/null || true
else
  echo "WARNING: lsregister not found; skipping LaunchServices fixup." >&2
fi

fail() {
  echo "ERROR: $1" >&2
  if [ "$HAD_PREVIOUS_INSTALL" -eq 1 ]; then
    restore_backup
    echo "ERROR: deploy failed verification; restored previous install." >&2
  else
    echo "ERROR: deploy failed verification; no previous install to restore. /Applications/$APP_NAME left as-is for inspection." >&2
  fi
  exit 1
}

echo "==> Verifying the installed bundle carries an Electron-ABI native module"
node scripts/verifyNativeAbi.js bundle "$INSTALL_PATH" || fail "native module ABI check failed"

echo "==> Verifying build stamp matches current commit"
INFO_PLIST="$INSTALL_PATH/Contents/Info.plist"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST" 2>/dev/null || true)"
if [ -z "$EXECUTABLE_NAME" ]; then
  fail "could not read CFBundleExecutable from $INFO_PLIST"
fi
EXECUTABLE_PATH="$INSTALL_PATH/Contents/MacOS/$EXECUTABLE_NAME"
if [ ! -x "$EXECUTABLE_PATH" ]; then
  fail "expected executable not found at $EXECUTABLE_PATH"
fi

BUILD_INFO_PATH="$INSTALL_PATH/Contents/Resources/app/electron/build-info.json"
if [ ! -f "$BUILD_INFO_PATH" ]; then
  fail "build-info.json not found at $BUILD_INFO_PATH"
fi
DEPLOYED_COMMIT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).commit)" "$BUILD_INFO_PATH")"
if [ "$DEPLOYED_COMMIT" != "$EXPECTED_COMMIT" ]; then
  fail "build stamp mismatch: bundle has commit '$DEPLOYED_COMMIT', expected '$EXPECTED_COMMIT'"
fi

echo "==> Launch smoke test ($EXECUTABLE_NAME)"
"$EXECUTABLE_PATH" &
APP_PID=$!
sleep 3
if ! kill -0 "$APP_PID" 2>/dev/null; then
  fail "installed app exited within 3 seconds of launch (likely a DB-open/ABI crash)"
fi
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

echo "==> All verifications passed; cleaning up backup"
rm -rf "$BACKUP_PATH"

echo
echo "Installed: $INSTALL_PATH"
echo "Deployed commit: $DEPLOYED_COMMIT"
echo "Launch with:  open \"$INSTALL_PATH\""
echo
echo "NOTE: better-sqlite3 is now built for Electron's ABI."
echo "      Before running 'npm test' (which runs under Node), run:"
echo "        npm rebuild better-sqlite3"
echo "      Before running 'npm run electron:dev' again, run:"
echo "        npx electron-rebuild -f -w better-sqlite3"
