@echo off
setlocal
cd /d "%~dp0"

set "RUNTIME_PYTHON=.venv\Scripts\python.exe"
if not exist "%RUNTIME_PYTHON%" (
  echo ERROR: The Windows AI runtime is not installed.
  echo Run setup-windows.bat once, then launch this file again.
  pause
  exit /b 2
)

"%RUNTIME_PYTHON%" supervisor.py %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%

