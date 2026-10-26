@echo off
title 马戏星探 Scout 服务器
cd /d "%~dp0"
echo.
echo   正在启动马戏星探 Scout 服务器 ...
echo   本机访问: http://localhost:3000
echo   关闭本窗口即可停止服务器。
echo.
start "open-browser" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node server.js
pause
