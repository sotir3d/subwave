@echo off
setlocal
cd /d "%~dp0"

set "BOOTSTRAP=bootstrap.py"

rem Prefer the registered Python launcher, then the common per-user 3.11 path.
py -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)" >nul 2>nul
if not errorlevel 1 (
  py -3.11 "%BOOTSTRAP%" %*
  goto :done
)

set "PY311=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if exist "%PY311%" (
  "%PY311%" "%BOOTSTRAP%" %*
  goto :done
)

echo.
echo ERROR: Python 3.11 was not found.
echo Install Python 3.11, then run this file again.
set "EXIT_CODE=2"
goto :finish

:done
set "EXIT_CODE=%ERRORLEVEL%"

:finish
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%

