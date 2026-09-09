#!/bin/bash
# Kept so the documented macOS path still works. The real thing is cross-platform and interactive:
#
#   node bridge/cli.js setup [project-dir]
exec node "$(cd "$(dirname "$0")" && pwd)/bridge/cli.js" setup "$@"
