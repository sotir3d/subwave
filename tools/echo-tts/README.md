# Echo-TTS for SUB/WAVE on Windows

This directory runs Echo-TTS as a Windows-native Remote TTS service for a
SUB/WAVE controller on another machine. It does not install, configure, inspect,
start, or stop llama.cpp. Use your normal GUI launcher for the LLM server.

## One-time setup

Requirements:

- Python 3.11
- Git
- A current NVIDIA driver
- Shared FFmpeg at `C:\ffmpeg\bin`

From this directory, run:

```bat
setup-windows.bat
```

The setup creates the repo-local `.venv`, installs CUDA 12.8 PyTorch and the
minimal Echo inference dependencies, checks out the pinned Echo source, and
downloads the Echo and Fish S1-DAC weights under `.runtime`.

To install a clean narrator reference during setup:

```bat
setup-windows.bat --voice "D:\Audio\narrator.wav"
```

You can also copy supported WAV, FLAC, MP3, OGG, or M4A references into
`voices\` yourself. Use only voices you are permitted to reproduce.

## Launch Echo

Double-click:

```text
start-echo-tts.bat
```

The batch file launches only Echo-TTS and keeps its CMD window attached:

- Physical CUDA device: `0` (GPU 1 is left free for the Windows display)
- Listen address: `0.0.0.0`
- Port: `18765`
- Health endpoint: `http://127.0.0.1:18765/health`
- Reference voices: `tools\echo-tts\voices\`
- VRAM mode: BF16 Fish decoder and a 576-latent (~27-second) acoustic window,
  matching Echo upstream's 8 GB guidance

The CMD window shows model-loading, health, and synthesis logs. Press Ctrl+C to
stop Echo. If Echo exits or startup fails, the batch file pauses so the error
remains visible.

Echo still needs roughly 8 GB free on physical GPU 0. If your GUI-launched LLM
uses both cards, configure its own GPU split so it leaves that headroom. The
Echo launcher does not modify the LLM process or its allocation.

## Configure SUB/WAVE

In the admin UI select the Remote TTS engine and use:

```text
Server URL: http://WINDOWS_IP:18765
Remote voice: narrator.wav
```

The Remote voice value must match the reference filename placed in `voices\`.
The currently installed bootstrap reference is `station_ident_default.wav` if
you have not replaced it yet.

Verify connectivity from the Ubuntu controller container:

```bash
docker compose exec controller curl -fsS http://WINDOWS_IP:18765/health
```

Allow inbound TCP 18765 through Windows Firewall only from the Ubuntu server's
LAN or Tailscale address. The bridge has no application-level authentication;
do not expose it publicly.

## Remote TTS contract

- `GET /health` reports model readiness, voices, and Echo's acoustic window.
- `POST /speak` accepts `{ "text": "...", "voice": "narrator.wav" }` and
  returns an uncompressed format-1, 16-bit PCM WAV.
- GPU inference is serialized.
- Missing or ambiguous references fail explicitly; the server never silently
  changes narrators.
- The HTTP port binds before model loading finishes. `/health` remains
  `ready: false` until both the model and at least one voice are available.

SUB/WAVE breaks long-form chapters into provider-sized calls and joins the WAV
responses, so Echo never has to synthesize an entire half-hour in one request.

Echo's weights and generated outputs are CC-BY-NC-SA-4.0 because of the Fish
S1-DAC dependency. Review the upstream Echo-TTS license before using generated
audio outside a private, non-commercial station.

## Tests

The bridge contract tests use a fake engine and do not load the model:

```bat
.venv\Scripts\python.exe test_server.py
```
