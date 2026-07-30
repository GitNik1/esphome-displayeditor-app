#!/bin/sh
set -eu

mkdir -p /data/drafts /data/history /data/database /data/settings

echo "[info] Starting ESPHome Display Editor"

# /app must be listable, not merely readable per-file: it is a sys.path entry,
# so Python scans it to find the `backend` package. A missing `/app/ r,` rule
# in the AppArmor profile shows up here as an otherwise baffling
# "ModuleNotFoundError: No module named 'backend'".
if ! ls /app >/dev/null 2>&1; then
  echo "[error] /app is not listable - check the '/app/ r,' AppArmor rule"
fi

cd /app
exec /opt/esphome-displayeditor/bin/uvicorn backend.app:create_app \
  --factory \
  --app-dir /app \
  --host 0.0.0.0 \
  --port 8099 \
  --proxy-headers \
  --forwarded-allow-ips="*"
