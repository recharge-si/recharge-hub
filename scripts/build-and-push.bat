@echo off
rem Build then push, same tag flags for both.
rem   scripts\build-and-push.bat --latest
rem   scripts\build-and-push.bat --dev --sha
setlocal enabledelayedexpansion
call "%~dp0build.bat" %* || exit /b !errorlevel!
call "%~dp0push.bat" %* || exit /b !errorlevel!
