#!/bin/sh
set -eu

mkdir -p /data/drafts /data/history /data/database /data/settings

echo "[info] Starting ESPHome Display Editor"
exec /opt/esphome-displayeditor/bin/uvicorn backend.app:create_app \
  --factory \
  --host 0.0.0.0 \
  --port 8099 \
  --proxy-headers \
  --forwarded-allow-ips="*"
