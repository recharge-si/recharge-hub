@echo off
rem Push already-built tags to Docker Hub. Needs `docker login` first.
rem   scripts\push.bat              -> pushes :latest
rem   scripts\push.bat --dev        -> pushes :dev
rem   scripts\push.bat --latest --dev
setlocal enabledelayedexpansion
call "%~dp0_image.bat" %* || exit /b !errorlevel!

for %%t in (%TAGS%) do (
  echo Pushing %IMAGE%:%%t
  docker push %IMAGE%:%%t || exit /b 1
)
echo Pushed:%TAGS%
