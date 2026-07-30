# Echo-TTS bridge for SUB/WAVE

This bridge runs [Echo-TTS](https://github.com/jordandare/echo-tts) as a
Windows-native, GPU-resident HTTP service for SUB/WAVE's **Remote** TTS engine.
SUB/WAVE can run in Docker on another Ubuntu machine; WAV audio travels over
HTTP, so the two hosts do not share a filesystem.

The service implements:

- `GET /health` — model readiness, installed voices, and Echo's acoustic window.
- `POST /speak` — accepts `{ "text": "...", "voice": "narrator.wav" }` and
  returns a format-1, 16-bit PCM WAV in the response body.
- `X-TTS-Voice-Used` — always reports the exact requested voice ID. A missing
  voice fails explicitly; it never silently changes narrator.
- One serialized inference lane — concurrent callers cannot compete for the
  same GPU or interleave model work.

## Requirements

- Windows 10/11 and a CUDA-capable NVIDIA GPU. Echo upstream states an 8 GB
  minimum; an RTX 3090 has ample room for the full 640-latent (~30 second)
  generation window.
- Current NVIDIA driver.
- Git.
- Python 3.11. Keep Echo in its own environment; do not use Subwave's or another
  model server's Python environment.
- A clean 5–15 second reference recording for each narrator. WAV is preferred.
  Use only voices you are permitted to reproduce.

Echo's model weights and generated outputs are CC-BY-NC-SA-4.0 because of the
Fish Speech S1-DAC dependency. Review the upstream license before using output
outside a private, non-commercial station.

## Install on Windows

From this directory in the Windows checkout of your Subwave fork:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script creates `%LOCALAPPDATA%\Subwave\EchoTTS`, clones the official Echo
repository, creates a Python 3.11 virtual environment, and installs upstream's
requirements. It deliberately does not auto-update an existing Echo checkout.

Copy a narrator reference into:

```text
%LOCALAPPDATA%\Subwave\EchoTTS\voices\narrator.wav
```

## Run on the second 3090

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 `
  -CudaDevice 1 `
  -DefaultVoice narrator.wav
```

`CUDA_VISIBLE_DEVICES=1` is set for the child process, so Echo sees the second
physical 3090 as its logical `cuda:0`. Keep llama.cpp on physical GPU 0.

The first launch downloads the Echo and Fish S1-DAC weights into the persistent
`%LOCALAPPDATA%\Subwave\EchoTTS\hf-cache` directory. The HTTP port binds
immediately and `/health` reports `ready: false` until model loading completes.
It also remains unready until at least one reference voice exists.

Check readiness:

```powershell
Invoke-RestMethod http://127.0.0.1:5001/health
```

Render a direct test:

```powershell
Invoke-WebRequest `
  -Uri http://127.0.0.1:5001/speak `
  -Method Post `
  -ContentType application/json `
  -Body '{"text":"This is an Echo TTS test.","voice":"narrator.wav"}' `
  -OutFile echo-test.wav
```

## Allow only the Ubuntu server through Windows Firewall

Run an elevated PowerShell once, replacing the address with the Ubuntu server's
LAN or Tailscale IP:

```powershell
New-NetFirewallRule `
  -DisplayName 'SUBWAVE Echo-TTS from Ubuntu' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 5001 `
  -RemoteAddress 192.168.1.50
```

The bridge has no application-level authentication. Do not expose port 5001 to
the public internet; restrict it with Windows Firewall, a trusted LAN, or
Tailscale.

## Connect the Ubuntu Subwave controller

From Ubuntu, first verify both the host and the controller container can reach
Windows:

```bash
curl http://WINDOWS_LAN_OR_TAILSCALE_IP:5001/health
docker compose exec controller \
  curl -fsS http://WINDOWS_LAN_OR_TAILSCALE_IP:5001/health
```

In SUB/WAVE:

1. Open **Admin → Settings → TTS voice**.
2. Choose **Remote** and set the server URL to
   `http://WINDOWS_LAN_OR_TAILSCALE_IP:5001` — no `/speak` suffix.
3. Open **Admin → Personas**, choose **Remote** for the on-air persona, and set
   **Remote voice** to `narrator.wav` exactly.
4. Play a voice preview before scheduling a spoken programme.

Do not use `host.docker.internal` in this two-machine layout: from the Ubuntu
container it means the Ubuntu host, not Windows.

## Tuning

The defaults mirror Echo upstream's high-speaker-CFG sampler and advertise a
30-second acoustic window. SUB/WAVE leaves headroom and sends roughly 25-second
chunks. Optional environment variables can be set before invoking `run.ps1`:

| Variable | Default | Purpose |
|---|---:|---|
| `ECHO_TTS_SEQUENCE_LENGTH` | `640` | Echo acoustic latents; lower this if VRAM is constrained. |
| `ECHO_TTS_NUM_STEPS` | `40` | Diffusion steps; lower is faster but may reduce quality. |
| `ECHO_TTS_CFG_SCALE_TEXT` | `3.0` | Text guidance. |
| `ECHO_TTS_CFG_SCALE_SPEAKER` | `8.0` | Reference-speaker guidance. |
| `ECHO_TTS_SEED` | `0` | Stable seed for consistent narration. |
| `ECHO_TTS_MODEL_DTYPE` | `bfloat16` | Resident Echo model dtype. |
| `ECHO_TTS_FISH_DTYPE` | `float32` | Decoder dtype; the 3090 can use the quality-first default. |

## Contract test without downloading the model

```powershell
python .\test_server.py
```

This exercises health, PCM WAV delivery, exact voice reporting, malformed
requests, and reference-path safety using a fake inference engine.

