@echo off
chcp 65001 >nul
title OpenCode 免费层网关 - 管理面板
cd /d "%~dp0"

rem 端口（可改）
if "%PANEL_PORT%"=="" set PANEL_PORT=8790

echo ============================================
echo   OpenCode 免费层网关
echo   管理面板 : http://127.0.0.1:%PANEL_PORT%/
echo   接口地址 : http://127.0.0.1:%PANEL_PORT%/v1
echo   初始密码 : admin123
echo ============================================
echo.
echo 关闭本窗口即停止服务。
echo.

rem ── 解析 node.exe：优先 %NODE_EXE% → PATH → 常见安装位置，不写死单一绝对路径 ──
if not defined NODE_EXE (
  where node.exe >nul 2>&1 && set "NODE_EXE=node"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.openagents\nodejs\node.exe" set "NODE_EXE=%USERPROFILE%\.openagents\nodejs\node.exe"
if not defined NODE_EXE (
  echo.
  echo [错误] 找不到 node.exe。
  echo        请安装 Node.js 并加入 PATH，或设置环境变量 NODE_EXE 指向 node.exe。
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:%PANEL_PORT%/"

"%NODE_EXE%" "%~dp0server.mjs"

echo.
echo [服务已退出]
pause
