@echo off
cd /d "%~dp0"
for /f "delims=" %%R in ('git remote get-url --push origin') do set "ASTRA_REMOTE=%%R"
if not "%ASTRA_REMOTE%"=="https://github.com/lotuswill/kalshi-pro-astra.git" (
  echo Refusing push: origin must be https://github.com/lotuswill/kalshi-pro-astra.git
  pause
  exit /b 1
)
git status --short
echo Review staged files before publishing. This script does not stage or commit files.
git push origin main
if errorlevel 1 (pause & exit /b 1)
echo Pushed to lotuswill/kalshi-pro-astra
pause
