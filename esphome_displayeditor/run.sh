#!/bin/sh
set -eu

mkdir -p /data/drafts /data/history /data/database /data/settings

echo "[info] Starting ESPHome Display Editor"
echo "[debug] APP_VERSION=${APP_VERSION:-unset} PYTHONPATH=${PYTHONPATH:-unset} PWD=$(pwd)"
echo "[debug] ls -la /app:"
ls -la /app 2>&1 || echo "[debug] /app missing or unreadable"
echo "[debug] ls -la /app/backend:"
ls -la /app/backend 2>&1 || echo "[debug] /app/backend missing or unreadable"
cd /app
exec /opt/esphome-displayeditor/bin/uvicorn backend.app:create_app \
  --factory \
  --app-dir /app \
  --host 0.0.0.0 \
  --port 8099 \
  --proxy-headers \
  --forwarded-allow-ips="*"
