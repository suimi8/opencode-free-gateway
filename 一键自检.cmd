@echo off
chcp 65001 >nul
title OpenCode 免费层逆向与网关 - 全量自检
cd /d "%~dp0"

echo.
echo   正在对归集后的目录做全量可用性自检...
echo   （第 5、6 项会真实调用上游接口，需要能联网）
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0自检全部.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo   [结果] 全部通过
) else (
  echo   [结果] 存在失败项，请查看上方 [FAIL] 输出
)
echo.
pause
exit /b %RC%
