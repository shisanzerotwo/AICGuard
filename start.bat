@echo off
rem AICGuard 一键启动（Windows）
rem 要求：Node.js >= 23.6（https://nodejs.org 下载 LTS 版）

node -v >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 23.6 及以上版本：https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set MAJOR=%%v
set MAJOR=%MAJOR:v=%
if %MAJOR% LSS 23 (
  echo [错误] Node.js 版本过低（当前 %MAJOR%，需要 ^>= 23.6）。本软件依赖 Node 原生 TypeScript 直跑能力。
  pause
  exit /b 1
)
echo [AICGuard] 启动控制台：http://127.0.0.1:7777 （Ctrl+C 停止）
start "" http://127.0.0.1:7777/
node "%~dp0ts\src\server.ts"
