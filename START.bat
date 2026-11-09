@echo off
cd /d "%~dp0"
echo KALSHI PRO ASTRA
where node >nul 2>nul || (echo Node.js 22 or newer required & pause & exit /b 1)
call npm ci
if errorlevel 1 (pause & exit /b 1)
echo Open http://127.0.0.1:5174
call npm run dev
