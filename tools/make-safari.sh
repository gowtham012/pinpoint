#!/usr/bin/env bash
# Build the Safari version of Pinpoint.
#
#   bash tools/make-safari.sh [output-dir]      default: ./safari-build (gitignored)
#
# Safari does not load unpacked extensions the way Chrome does: the extension has to be wrapped in
# a macOS app and built with Xcode. This runs Apple's converter with the arguments that actually
# work, then builds it.
#
# The gotcha this script exists to save you from: the converter derives the APP's bundle id from
# the last component of --bundle-identifier and the extension's as "<that>.Extension". Pass
# "dev.pinpoint.safari" with an app named Pinpoint and you get app dev.pinpoint.Pinpoint but
# extension dev.pinpoint.safari.Extension — which is not a prefix of the app id, and Xcode fails
# with "Embedded binary's bundle identifier is not prefixed with the parent app's bundle
# identifier". The last component must match the app name.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO/safari-build}"
APP="Pinpoint"
BUNDLE="dev.pinpoint.$APP"

command -v xcrun >/dev/null || { echo "Xcode is required (not just the command line tools)."; exit 1; }
xcrun --find safari-web-extension-converter >/dev/null 2>&1 || {
  echo "safari-web-extension-converter not found — install Xcode from the App Store."; exit 1; }

echo "▸ converting extension/ for Safari"
rm -rf "$OUT"
mkdir -p "$OUT"
xcrun safari-web-extension-converter "$REPO/extension" \
  --project-location "$OUT" \
  --app-name "$APP" \
  --bundle-identifier "$BUNDLE" \
  --macos-only --no-open --no-prompt --force

echo
echo "▸ building"
xcodebuild -project "$OUT/$APP/$APP.xcodeproj" -scheme "$APP" -configuration Debug \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" -destination 'platform=macOS' build \
  | tail -3

APP_PATH="$(xcodebuild -project "$OUT/$APP/$APP.xcodeproj" -scheme "$APP" -configuration Debug \
  -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR/ {print $2; exit}')/$APP.app"

cat <<EOF

▸ built: $APP_PATH

To run it:
  1. open "$APP_PATH"                    (launches once so Safari sees it)
  2. Safari ▸ Settings ▸ Advanced ▸ tick "Show features for web developers"
  3. Safari ▸ Develop ▸ tick "Allow Unsigned Extensions"   (resets when Safari quits)
  4. Safari ▸ Settings ▸ Extensions ▸ enable Pinpoint, and allow it on localhost

Known Safari limitation: the manifest's "world": "MAIN" content script is not supported, so the
React/Vue component chain and source-file hint are not available there. Everything else — picking,
regions, comments, pins, screenshots, the bridge and MCP — works the same. Pinpoint already handles
a page with no framework metadata, and tells the agent so.
EOF
