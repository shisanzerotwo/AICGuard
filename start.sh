#!/usr/bin/env bash
# AICGuard 一键启动（macOS / Linux）
# 要求：Node.js >= 23.6
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 23.6+：https://nodejs.org"
  exit 1
fi
MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$MAJOR" -lt 23 ]; then
  echo "[错误] Node.js 版本过低（$(node -v)），需要 >= 23.6（原生 TypeScript 直跑）"
  exit 1
fi
echo "[AICGuard] 启动控制台：http://127.0.0.1:7777 （Ctrl+C 停止）"
node "$(dirname "$0")/ts/src/server.ts"
