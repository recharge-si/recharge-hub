@echo off
rem Build the production image locally and tag it for Docker Hub.
rem   scripts\build.bat              -> time4action/recharge-hub:latest
rem   scripts\build.bat --dev        -> :dev
rem   scripts\build.bat --latest --sha
setlocal enabledelayedexpansion
call "%~dp0_image.bat" %* || exit /b !errorlevel!

set "ARGS="
for %%t in (%TAGS%) do set "ARGS=!ARGS! -t %IMAGE%:%%t"

echo Building %IMAGE% with tags:%TAGS%
docker build!ARGS! "%~dp0.." || exit /b !errorlevel!
echo Built:%TAGS%
