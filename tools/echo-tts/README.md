# Windows AI runtime for SUB/WAVE

This directory provides the Windows half of a split SUB/WAVE installation:

- SUB/WAVE, Icecast, Liquidsoap, and the web UI run on Ubuntu.
- `llama-server` and Echo-TTS run on the Windows machine with two RTX 3090s.
- One batch file starts and supervises both Windows services.

## One-time setup

Python 3.11, Git, a current NVIDIA driver, and a shared FFmpeg build are
required. Your existing `C:\ffmpeg\bin` is detected automatically. From this
directory, run:

```bat
setup-windows.bat
```

The bootstrap performs the complete software setup:

- Creates the real, repo-local `.venv` using Python 3.11.
- Installs CUDA 12.8 PyTorch and only Echo's inference dependencies; Gradio is
  not installed.
- Detects a shared FFmpeg runtime for TorchCodec and records its `bin` path.
- Checks out Echo-TTS at pinned revision
  `2ed95fce62d33bf7b56f835fd9ec0f0b6fb9155e`.
- Downloads Echo and Fish S1-DAC weights into `.runtime/hf-cache`.
- Installs the official CUDA 12.4 llama.cpp `b10189` Windows runtime.
- Creates the ignored machine-local `windows-ai.json` configuration.

`.venv`, downloaded runtimes, model caches, GGUF files, reference voices, logs,
and local configuration are gitignored.

If the GGUF and narrator recording already exist, configure them during setup:

```bat
setup-windows.bat --model "D:\Models\gemma.gguf" --voice "D:\Audio\narrator.wav"
```

If FFmpeg lives somewhere other than `C:\ffmpeg`, add
`--ffmpeg-dir "D:\path\to\ffmpeg"`.

Otherwise, after setup:

1. Put exactly one `.gguf` file in `models\`.
2. Put `narrator.wav` in `voices\`.

The launcher automatically selects a sole model or voice. If either directory
contains multiple choices, set the explicit paths/IDs in `windows-ai.json`.

## Start everything

Double-click:

```text
start-windows-ai.bat
```

That is the normal day-to-day operation. The supervisor:

- Runs llama.cpp across both GPUs at `0.0.0.0:8080` with one request slot. The
  default `3,1` tensor split keeps most of the Q8 model on GPU 0.
- Runs Echo-TTS on physical GPU 1 at `0.0.0.0:5001`; it can coexist with the
  smaller llama.cpp allocation on that card.
- Prefixes both services' output in one console and writes a combined log under
  `.runtime\logs`.
- Waits for both health endpoints and prints when the Windows AI side is ready.
- Stops both children together when you press Ctrl+C or if either process dies.

Validate configuration without launching models:

```bat
start-windows-ai.bat --check
```

## Connect the Ubuntu server

Allow TCP ports 8080 and 5001 through Windows Firewall only from the Ubuntu
server's LAN or Tailscale address. Do not expose either port publicly.

In SUB/WAVE configure:

```text
LLM provider: OpenAI-compatible
LLM base URL: http://WINDOWS_IP:8080/v1
LLM model: subwave-local

TTS engine: Remote
TTS server URL: http://WINDOWS_IP:5001
Persona Remote voice: narrator.wav
```

Verify from inside the Ubuntu controller container:

```bash
docker compose exec controller curl -fsS http://WINDOWS_IP:8080/health
docker compose exec controller curl -fsS http://WINDOWS_IP:5001/health
```

Do not use `host.docker.internal` in a two-machine setup. From Ubuntu it refers
to the Ubuntu Docker host, not the Windows PC.

## Echo behavior

The bridge implements SUB/WAVE's Remote TTS contract:

- `GET /health` reports readiness, voices, and the ~30-second acoustic window.
- `POST /speak` accepts `{ "text": "...", "voice": "narrator.wav" }` and
  returns a format-1, 16-bit PCM WAV.
- GPU inference is serialized.
- Missing or ambiguous voices fail explicitly; narrator substitution is never
  silent.
- The model binds its HTTP port immediately but remains `ready: false` while
  loading. SUB/WAVE continues playing music until it becomes ready.

Echo upstream lists 8 GB VRAM as its minimum and recommends short clean
reference audio. The full model completed a cold-load test on this machine's
second RTX 3090 while the existing llama.cpp model remained resident. A 5–15
second WAV is a good narrator reference. Echo's weights
and generated outputs are CC-BY-NC-SA-4.0 because of the Fish S1-DAC dependency;
review the [upstream Echo-TTS license](https://github.com/jordandare/echo-tts)
before using generated output outside a private, non-commercial station.

## Machine-local configuration

`windows-ai.json` is copied from `windows-ai.example.json` once and then left
alone by normal setup reruns. Important fields:

- `llama.model`: an absolute GGUF path, or blank to auto-select from `models\`.
- `llama.contextSize`: defaults to 32768.
- `llama.parallel`: fixed to one by default.
- `llama.gpuDevice`: `0,1` exposes both 3090s to the model.
- `llama.extraArgs`: defaults to `--tensor-split 3,1` for the 26.8 GB Q8 GGUF.
- `echo.defaultVoice`: exact filename or unique filename stem.
- `echo.ffmpegDirectory`: directory containing `ffmpeg.exe` and the shared
  FFmpeg DLLs. Setup fills this automatically.
- `echo.sequenceLength`: 640 is Echo's full approximately-30-second window.

## Tests

The bridge/supervisor contract tests do not load torch or download models:

```bat
.venv\Scripts\python.exe test_server.py
```
