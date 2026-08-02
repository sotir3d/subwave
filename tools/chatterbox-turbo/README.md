# Chatterbox Turbo for SUB/WAVE (Windows GPU host)

This is a Windows-native Chatterbox Turbo service for an Ubuntu/Docker
SUB/WAVE station. The model stays on the Windows RTX GPU; the controller uses
its existing **Remote** TTS engine and receives each rendered WAV over HTTP.
No shared filesystem and no Chatterbox container on Ubuntu are required.

The bridge deliberately runs SUB/WAVE's existing
`controller/scripts/chatterbox_worker.py` as its resident inference process.
That preserves the fork's Chatterbox Turbo integration instead of maintaining
a second inference implementation:

- official `ChatterboxTurboTTS` model, kept loaded between requests;
- sentence/clause-aware chunks capped at 280 characters;
- a short pause between stitched model chunks;
- one reference voice reused for every chunk;
- the CUDA/librosa compatibility guard already used by the Docker sidecar;
- serialized long-form rendering in both the controller and this service.

## One-time setup

Python 3.11 and a reasonably current NVIDIA driver are required. From a normal
Command Prompt:

```bat
cd D:\Documents\Repositories\subwave\tools\chatterbox-turbo
setup-windows.bat --voice "C:\path\to\narrator.wav"
```

The reference recording should be clean speech and longer than five seconds.
You can omit `--voice` and copy WAV files into `voices\` later. The setup:

1. creates `.venv\`;
2. installs CUDA PyTorch 2.6 and pinned `chatterbox-tts` 0.1.7;
3. validates CUDA and the Turbo import;
4. downloads the official weights into `.runtime\hf-cache\`;
5. optionally copies the supplied reference recording into `voices\`.

Setup does not install or control llama.cpp. Chatterbox does not need the
separate `C:\ffmpeg` installation for PCM-WAV references and output.

## Normal launch

Double-click:

```text
start-chatterbox-turbo.bat
```

The command window remains open and stops the model with Ctrl+C. Defaults:

- port `18766`;
- listen address `0.0.0.0` (LAN-accessible);
- physical CUDA GPU **0**, leaving GPU 1 free for the Windows display;
- model-safe chunks of at most 280 characters;
- service-level assembled long-form window advertised as 120 seconds.

To use another GPU, change `CUDA_VISIBLE_DEVICES=0` in the launch batch file.
The selected physical GPU becomes `cuda:0` inside the isolated process.

Check readiness locally:

```powershell
Invoke-RestMethod http://127.0.0.1:18766/health
```

The HTTP port binds immediately, but `ready` remains `false` until the model is
loaded. Windows Firewall may need an inbound TCP rule for port 18766.

## SUB/WAVE configuration

In **Settings -> Voice**:

1. choose **Remote** as the engine;
2. set the server URL to `http://WINDOWS_LAN_IP:18766`;
3. save and wait for the availability badge to turn healthy.

In **Personas -> Voice**, keep the engine set to **Remote** and enter either:

- `narrator.wav` (exact filename), or
- `narrator` (accepted when that stem is unique).

The server rejects missing or ambiguous names with HTTP 422; it never silently
substitutes another cloned voice. An empty voice uses Turbo's built-in voice.

There is intentionally no separate "Remote Chatterbox" controller category.
The generic Remote transport is already the correct LAN boundary. The bridge's
`/health` response advertises `engine=chatterbox-turbo`, its voice list,
long-form budget, and features. SUB/WAVE uses those capabilities for long-form
chunk sizing and Chatterbox paralinguistic prompts while keeping the lean
Ubuntu controller free of PyTorch.

Echo remains available independently on port 18765. Point SUB/WAVE's one Remote
URL at whichever service you want to audition; neither launcher touches the
other or your LLM server.
