#!/bin/sh
set -eu

mkdir -p /data/drafts /data/history /data/database /data/settings /data/runtime
chmod 0700 /data/runtime

echo "[info] Starting ESPHome Display Editor"

# /app must be listable, not merely readable per-file: it is a sys.path entry,
# so Python scans it to find the `backend` package. A missing `/app/ r,` rule
# in the AppArmor profile shows up here as an otherwise baffling
# "ModuleNotFoundError: No module named 'backend'".
if ! ls /app >/dev/null 2>&1; then
  echo "[error] /app is not listable - check the '/app/ r,' AppArmor rule"
fi

cd /app

MCP_RUNTIME="$(/opt/esphome-displayeditor/bin/python -m backend.mcp.runtime)"
set -- ${MCP_RUNTIME}
MCP_MODE="$1"
MCP_PORT="$2"
MCP_ACCESS="$3"
if [ "${MCP_MODE}" = "lan" ]; then
  echo "[info] Starting MCP server on port ${MCP_PORT} (access: ${MCP_ACCESS})"
  /opt/esphome-displayeditor/bin/uvicorn backend.mcp.app:create_mcp_app \
    --factory \
    --app-dir /app \
    --host 0.0.0.0 \
    --port "${MCP_PORT}" \
    --no-proxy-headers &
fi

exec /opt/esphome-displayeditor/bin/uvicorn backend.app:create_app \
  --factory \
  --app-dir /app \
  --host 0.0.0.0 \
  --port 8099 \
  --no-proxy-headers
