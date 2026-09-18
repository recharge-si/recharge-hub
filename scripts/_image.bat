@echo off
rem Shared by build.bat, push.bat and build-and-push.bat. Not run directly.
rem Parses tag flags into TAGS (space-separated). No flag means latest.
rem
rem   --latest      tag as latest
rem   --dev         tag as dev
rem   --tag NAME    tag as NAME (repeatable)
rem   --sha         tag as short git commit hash
rem
rem Flags combine: `--latest --dev` yields both tags.
set "IMAGE=time4action/recharge-hub"
set "TAGS="

:parse
if "%~1"=="" goto done
if /i "%~1"=="--latest" (set "TAGS=%TAGS% latest" & shift & goto parse)
if /i "%~1"=="--dev"    (set "TAGS=%TAGS% dev" & shift & goto parse)
if /i "%~1"=="--tag" (
  if "%~2"=="" (echo --tag needs a value & exit /b 2)
  set "TAGS=%TAGS% %~2" & shift & shift & goto parse
)
if /i "%~1"=="--sha" (
  for /f %%h in ('git rev-parse --short HEAD') do set "TAGS=%TAGS% %%h"
  shift & goto parse
)
echo Unknown option: %~1
echo Usage: %~n0 [--latest] [--dev] [--sha] [--tag NAME]...
exit /b 2

:done
if "%TAGS%"=="" set "TAGS=latest"
exit /b 0
