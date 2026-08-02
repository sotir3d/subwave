@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SUB/WAVE Echo-TTS - port 18765

set "RUNTIME_PYTHON=.venv\Scripts\python.exe"
set "ECHO_REPO=%CD%\.runtime\echo-tts"
set "VOICE_DIR=%CD%\voices"
set "FFMPEG_DIR=C:\ffmpeg\bin"

if not exist "%RUNTIME_PYTHON%" (
  echo ERROR: The Echo-TTS virtual environment is not installed.
  echo Run setup-windows.bat once, then launch this file again.
  goto :failed
)
if not exist "%ECHO_REPO%\inference.py" (
  echo ERROR: The pinned Echo-TTS checkout is missing.
  echo Run setup-windows.bat once, then launch this file again.
  goto :failed
)
if not exist "%FFMPEG_DIR%\ffmpeg.exe" (
  echo ERROR: Shared FFmpeg was not found at %FFMPEG_DIR%.
  goto :failed
)
if not exist "%VOICE_DIR%" mkdir "%VOICE_DIR%"

rem Echo only. This script never starts, stops, probes, or configures llama.cpp.
rem GPU 0 is the default because physical GPU 1 drives the desktop.
set "CUDA_VISIBLE_DEVICES=0"
set "ECHO_TTS_DEVICE=cuda"
set "ECHO_TTS_REPO=%ECHO_REPO%"
set "ECHO_TTS_VOICE_DIR=%VOICE_DIR%"
set "ECHO_TTS_DEFAULT_VOICE="
set "ECHO_TTS_LISTEN_ADDRESS=0.0.0.0"
set "ECHO_TTS_PORT=18765"
rem Upstream's 8 GB mode leaves room for an LLM using the other GPU(s).
set "ECHO_TTS_FISH_DTYPE=bfloat16"
set "ECHO_TTS_SEQUENCE_LENGTH=576"
set "HF_HOME=%CD%\.runtime\hf-cache"
set "PYTHONUNBUFFERED=1"
set "PATH=%FFMPEG_DIR%;%PATH%"

echo.
echo Starting Echo-TTS only
echo   GPU:        physical CUDA device 0 ^(GPU 1 left for the display^)
echo   Listen:     http://0.0.0.0:18765
echo   Health:     http://127.0.0.1:18765/health
echo   Voices:     %VOICE_DIR%
echo   VRAM mode:  upstream 8 GB mode ^(BF16 decoder, 27-second window^)
echo.
echo Press Ctrl+C to stop Echo-TTS.
echo.

"%RUNTIME_PYTHON%" server.py
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Echo-TTS exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:failed
echo.
pause
exit /b 2
