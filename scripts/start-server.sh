#!/bin/sh
set -e

# Startup diagnostics — these WILL appear in Railway deploy logs
echo "=== Craft Agent Server Starting ==="
echo "PORT=${PORT:-not set}"
echo "CRAFT_RPC_HOST=${CRAFT_RPC_HOST:-not set}"
echo "CRAFT_DATA_DIR=${CRAFT_DATA_DIR:-not set}"
echo "CRAFT_BUNDLED_ASSETS_ROOT=${CRAFT_BUNDLED_ASSETS_ROOT:-not set}"
echo "CRAFT_SERVER_TOKEN=${CRAFT_SERVER_TOKEN:+***set***}"
echo "NODE_ENV=${NODE_ENV:-not set}"
echo "PWD=$(pwd)"

# Railway sets PORT dynamically — sync CRAFT_RPC_PORT to match
export CRAFT_RPC_PORT="${PORT:-9100}"
echo "CRAFT_RPC_PORT=${CRAFT_RPC_PORT} (synced from PORT)"

# Verify critical files exist
if [ ! -f "packages/server/src/index.ts" ]; then
    echo "FATAL: packages/server/src/index.ts not found!"
    ls -la packages/server/src/ 2>/dev/null || echo "packages/server/src/ does not exist"
    exit 1
fi

if [ ! -f "apps/electron/resources/config-defaults.json" ]; then
    echo "WARNING: apps/electron/resources/config-defaults.json not found!"
    ls -la apps/electron/resources/ 2>/dev/null || echo "apps/electron/resources/ does not exist"
fi

# Verify CRAFT_SERVER_TOKEN is set
if [ -z "$CRAFT_SERVER_TOKEN" ]; then
    echo "FATAL: CRAFT_SERVER_TOKEN is not set! The server requires this env var."
    exit 1
fi

# Ensure data directories exist
mkdir -p "${CRAFT_DATA_DIR:-/data/.craft-agent}/workspaces"

echo "=== Launching bun ==="

# Use exec to replace shell with bun (proper signal handling)
# stdbuf -oL prevents stdout buffering in Docker
exec stdbuf -oL bun packages/server/src/index.ts
