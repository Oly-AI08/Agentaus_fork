@echo off
rem Agentaus PC companion launcher for Windows (double-click StartWindows.cmd).
rem Requires Node.js 22 or newer. Keep server.mjs, StartWindows.cmd and
rem Agentaus.html together in one folder.

setlocal
title Agentaus PC Companion
cd /d "%~dp0"

if not exist "%~dp0server.mjs" (
  echo.
  echo server.mjs was not found next to StartWindows.cmd.
  echo Keep server.mjs, StartWindows.cmd and Agentaus.html together, then
  echo double-click StartWindows.cmd again.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0Agentaus.html" (
  echo.
  echo Agentaus.html was not found next to StartWindows.cmd.
  echo Keep server.mjs, StartWindows.cmd and Agentaus.html together, then
  echo double-click StartWindows.cmd again.
  echo.
  pause
  exit /b 1
)

set "NODE_MAJOR=0"
for /f "tokens=1 delims=." %%v in ('node --version 2^>nul') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 22 (
  echo.
  echo Node.js 22 or newer is required for the companion.
  echo Install it from https://nodejs.org/en/download, then double-click
  echo StartWindows.cmd again.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Agentaus PC Companion
echo ============================================================
echo.
echo This window runs the local companion service. Keep it open
echo while you use the Agentaus app, and press Ctrl+C to stop it.
echo.
echo Advanced options can be passed when starting this script, for
echo example:  StartWindows.cmd --port 43128 --state-dir "C:\companion-backups"
echo.

set "ORIGIN="
echo Enter the website origin that may use this companion.
echo Use the protocol and host only. For a project site such as
echo https://YOUR-USERNAME.github.io/agentaus/ you approve
echo https://YOUR-USERNAME.github.io
set /p "ORIGIN=Origin (Enter for https://oly-ai08.github.io): "
if not defined ORIGIN set "ORIGIN=https://oly-ai08.github.io"

set "ROOTS="
:choose
set "FOLDER="
echo.
echo Approved folders give the app access to their contents with backups
echo and Undo. Approve one or more folders.
set /p "FOLDER=Full folder path (Enter to finish): "
if defined FOLDER (
  if exist "%FOLDER%\." (
    set ROOTS=%ROOTS% --root "%FOLDER%"
    echo Approved: %FOLDER%
    goto choose
  )
  echo That path was not found. Type a full path such as C:\Users\YourName\Documents
  goto choose
)
if not defined ROOTS (
  echo At least one approved folder is required.
  goto choose
)

echo.
echo Starting the companion...
echo.
echo The pairing token and local app address are printed below.
echo Keep this window open while you use the app, and press Ctrl+C to stop it.
echo.
node server.mjs %* --origin "%ORIGIN%" %ROOTS%
echo.
echo The companion has stopped. Close this window or press Ctrl+C.
pause
