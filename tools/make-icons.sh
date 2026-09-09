#!/usr/bin/env bash
# Regenerate the extension icons, and the in-page bar's mark, from tools/logo/mark.png.
#
#   bash tools/make-icons.sh
#
# The source is a black drawing on white with no alpha, so white becomes transparency: the
# toolbar and the page bar both sit on backgrounds we do not control. The bar mark is written
# as an alpha-only data URI into content.js, where it is used as a CSS mask so the shape can
# still take the accent colour and turn white while armed, exactly as the old dot did.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
python3 tools/logo/make-icons.py
echo "▸ icons written to extension/"
