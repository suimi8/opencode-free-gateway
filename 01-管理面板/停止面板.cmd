@echo off
chcp 65001 >nul
title 停止 OpenCode 免费层网关

if "%PANEL_PORT%"=="" set PANEL_PORT=8790

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PANEL_PORT%" ^| findstr LISTENING') do (
  echo 正在停止 PID %%a ...
  taskkill /F /PID %%a >nul 2>&1
  set FOUND=1
)

if "%FOUND%"=="1" (echo 已停止。) else (echo 端口 %PANEL_PORT% 上没有正在运行的服务。)
timeout /t 2 >nul
