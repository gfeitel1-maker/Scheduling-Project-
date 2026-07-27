#!/usr/bin/env bash
#
# Build Shoresh and install it to /Applications.
#
# Why this script exists — two non-obvious macOS failure modes bit us hard,
# and both are invisible (the app launches, shows no window, logs nothing):
#
#   1. Duplicate LaunchServices registration.
#      This project lives under a directory literally named "Applications",
#      so macOS indexes the electron-builder output at release/mac/Shoresh.app
#      as a SECOND app sharing bundle id com.shoresh.scheduling. `open` then
#      resolves to the conflicted registration and silently does nothing.
#      Direct exec of the binary still works, which makes this very confusing
#      to diagnose. Fix: unregister the build output, register the installed app.
#
#   2. `cp -R` is not a safe way to install a .app bundle.
#      Use ditto, which preserves bundle metadata/extended attributes.
#
# Also handles the native-module ABI flip: `electron-builder` runs its own
# @electron/rebuild pass that leaves the PROJECT copy of better-sqlite3 built
# for Electron's ABI. `npm test` runs under Node and needs the Node ABI, so
# this script prints the command to switch back.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Shoresh.app"
BUILD_OUTPUT="$PROJECT_DIR/release/mac/$APP_NAME"
INSTALL_PATH="/Applications/$APP_NAME"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

cd "$PROJECT_DIR"

echo "==> Building (vite build + electron-builder)"
npm run electron:build

if [ ! -d "$BUILD_OUTPUT" ]; then
  echo "ERROR: expected build output at $BUILD_OUTPUT but it does not exist." >&2
  exit 1
fi

echo "==> Installing to $INSTALL_PATH (ditto, not cp -R)"
rm -rf "$INSTALL_PATH"
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

echo
echo "Installed: $INSTALL_PATH"
echo "Launch with:  open \"$INSTALL_PATH\""
echo
echo "NOTE: better-sqlite3 is now built for Electron's ABI."
echo "      Before running 'npm test' (which runs under Node), run:"
echo "        npm rebuild better-sqlite3"
echo "      Before running 'npm run electron:dev' again, run:"
echo "        npx electron-rebuild -f -w better-sqlite3"
echo
echo "To put an alias on the Desktop, drag $INSTALL_PATH to the Desktop"
echo "while holding Cmd+Option. A plain 'ln -s' symlink does NOT work —"
echo "Finder and 'open' will not launch an app bundle through one."
