@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SUB/WAVE Chatterbox Turbo - port 18766

set "RUNTIME_PYTHON=.venv\Scripts\python.exe"
set "WORKER=%~dp0..\..\controller\scripts\chatterbox_worker.py"
set "VOICE_DIR=%CD%\voices"

if not exist "%RUNTIME_PYTHON%" (
  echo ERROR: The Chatterbox Turbo virtual environment is not installed.
  echo Run setup-windows.bat once, then launch this file again.
  goto :failed
)
if not exist "%WORKER%" (
  echo ERROR: The SUB/WAVE Chatterbox worker is missing:
  echo   %WORKER%
  goto :failed
)
if not exist "%VOICE_DIR%" mkdir "%VOICE_DIR%"

rem Chatterbox Turbo only. This script never starts, stops, probes, or
rem configures llama.cpp. GPU 0 is the default because GPU 1 drives the desktop.
set "CUDA_VISIBLE_DEVICES=0"
set "CHATTERBOX_DEVICE=cuda"
set "CHATTERBOX_TTS_PYTHON=%CD%\%RUNTIME_PYTHON%"
set "CHATTERBOX_TTS_WORKER=%WORKER%"
set "CHATTERBOX_TTS_VOICE_DIR=%VOICE_DIR%"
set "CHATTERBOX_TTS_DEFAULT_VOICE="
set "CHATTERBOX_TTS_LISTEN_ADDRESS=0.0.0.0"
set "CHATTERBOX_TTS_PORT=18766"
set "CHATTERBOX_TTS_MAX_SECONDS=120"
set "CHATTERBOX_MAX_CHUNK_CHARS=280"
set "CHATTERBOX_CHUNK_GAP_MS=160"
set "HF_HOME=%CD%\.runtime\hf-cache"
set "PYTHONUNBUFFERED=1"

echo.
echo Starting Chatterbox Turbo only
echo   GPU:        physical CUDA device 0 ^(GPU 1 left for the display^)
echo   Listen:     http://0.0.0.0:18766
echo   Health:     http://127.0.0.1:18766/health
echo   Voices:     %VOICE_DIR%
echo   Long-form:  SUB/WAVE worker, 280-character model chunks, stitched WAV
echo.
echo Press Ctrl+C to stop Chatterbox Turbo.
echo.

"%RUNTIME_PYTHON%" server.py
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Chatterbox Turbo exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:failed
echo.
pause
exit /b 2
