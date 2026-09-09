#!/usr/bin/env bash
# Regenerate the extension icons from tools/logo/*.svg.
#
#   bash tools/make-icons.sh
#
# Two sources on purpose. mark.svg is the full mark; at 16 device pixels its burst strokes and the
# ring merge into one unreadable blob, so mark-16.svg is a simplified cut — no burst, thicker ring,
# larger cursor — used for the toolbar size only.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/tools/logo"
node render.mjs mark.svg     "$REPO/extension/icon" 48 128
node render.mjs mark-16.svg  /tmp/pinpoint-icon 16
cp /tmp/pinpoint-icon16.png "$REPO/extension/icon16.png"
rm -f "$REPO/extension/icon-preview.png" /tmp/pinpoint-icon16.png /tmp/pinpoint-icon-preview.png
echo "▸ icons written to extension/"
