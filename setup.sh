#!/bin/bash
# One-shot setup: installs deps, registers Pinpoint with Claude Code (MCP + automatic hooks),
# opens chrome://extensions, and starts the bridge.
#
#   bash ~/Downloads/pinpoint/setup.sh [/path/to/project]      default: ~/Desktop/markus
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:-$HOME/Desktop/markus}"

[ -d "$PROJECT" ] || { echo "Project folder not found: $PROJECT"; echo "Pass it as the first argument."; exit 1; }
command -v node >/dev/null || { echo "node not found — install Node 18+ first"; exit 1; }

echo "▸ bridge dependencies"
[ -d "$DIR/bridge/node_modules/@modelcontextprotocol" ] || (cd "$DIR/bridge" && npm install --no-audit --no-fund)

if command -v claude >/dev/null; then
  echo "▸ registering the MCP server with Claude Code"
  claude mcp remove pinpoint -s user >/dev/null 2>&1 || true
  claude mcp add pinpoint -s user -- node "$DIR/bridge/cli.js" mcp
  echo "▸ installing hooks so annotations reach Claude without being asked"
  node "$DIR/bridge/cli.js" install-hooks "$PROJECT"
else
  echo "▸ 'claude' CLI not on PATH — later, run:"
  echo "    claude mcp add pinpoint -s user -- node $DIR/bridge/cli.js mcp"
  echo "    node $DIR/bridge/cli.js install-hooks $PROJECT"
fi

echo "▸ opening chrome://extensions — Developer mode on → Load unpacked → choose:"
echo "    $DIR/extension"
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true

echo
echo "▸ starting the bridge for $PROJECT   (Ctrl-C to stop)"
exec node "$DIR/bridge/cli.js" --project "$PROJECT"
