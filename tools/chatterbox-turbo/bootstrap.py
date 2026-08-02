"""One-time Windows bootstrap for SUB/WAVE's Chatterbox Turbo service.

Creates a repo-local Python 3.11 virtual environment, installs the pinned
official Chatterbox Turbo package with CUDA PyTorch, prefetches model weights,
and optionally copies a narrator reference into the service voice directory.
It deliberately does not start, stop, probe, or configure llama.cpp.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
RUNTIME = ROOT / ".runtime"
HF_CACHE = RUNTIME / "hf-cache"
VOICES = ROOT / "voices"

PYTORCH_INDEX = "https://download.pytorch.org/whl/cu124"
PYTORCH_VERSION = "2.6.0"
CHATTERBOX_VERSION = "0.1.7"
ONNXRUNTIME_VERSION = "1.27.0"
SETUPTOOLS_VERSION = "80.10.2"
WHEEL_VERSION = "0.47.0"


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"> {' '.join(command)}", flush=True)
    completed = subprocess.run(command, env=env, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"command exited {completed.returncode}: {command[0]}")


def output(command: list[str], *, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        command,
        env=env,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"command exited {completed.returncode}: {command[0]}")
    return completed.stdout.strip()


def require_python_311() -> None:
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError(
            f"bootstrap must run under Python 3.11; found {sys.version_info.major}.{sys.version_info.minor}",
        )


def venv_python() -> Path:
    return VENV / "Scripts" / "python.exe"


def ensure_directories() -> None:
    for directory in (RUNTIME, HF_CACHE, VOICES):
        directory.mkdir(parents=True, exist_ok=True)


def ensure_venv() -> None:
    python = venv_python()
    if not python.is_file():
        print(f"Creating Python 3.11 virtual environment at {VENV}")
        run([sys.executable, "-m", "venv", str(VENV)])
    version = output([str(python), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
    if version != "3.11":
        raise RuntimeError(f"existing venv uses Python {version}; remove {VENV} and run setup again")


def runtime_environment() -> dict[str, str]:
    import os

    env = os.environ.copy()
    env["HF_HOME"] = str(HF_CACHE)
    return env


def install_python_dependencies() -> None:
    python = str(venv_python())
    run([
        python, "-m", "pip", "install", "--upgrade", "pip",
        f"setuptools=={SETUPTOOLS_VERSION}", f"wheel=={WHEEL_VERSION}",
    ])
    # Install the exact CUDA build first. chatterbox-tts pins torch/torchaudio
    # to 2.6.0; satisfying those pins up front prevents pip from replacing the
    # CUDA wheels with a generic/CPU build while resolving the remaining deps.
    run([
        python, "-m", "pip", "install", "--upgrade",
        f"torch=={PYTORCH_VERSION}", f"torchaudio=={PYTORCH_VERSION}",
        "--index-url", PYTORCH_INDEX,
    ])
    run([
        python, "-m", "pip", "install", "--upgrade",
        "numpy==1.26.4", "Cython==3.2.8",
        f"onnxruntime=={ONNXRUNTIME_VERSION}",
        f"chatterbox-tts=={CHATTERBOX_VERSION}",
    ])
    # Re-assert the setuptools ceiling after dependency resolution. Perth still
    # imports pkg_resources, which setuptools 81 removed.
    run([python, "-m", "pip", "install", "--upgrade", f"setuptools=={SETUPTOOLS_VERSION}"])


def validate_python_runtime() -> None:
    script = """
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS
if not torch.version.cuda:
    raise RuntimeError(f"CPU-only PyTorch was installed: {torch.__version__}")
if not torch.cuda.is_available():
    raise RuntimeError("PyTorch cannot see an NVIDIA CUDA device")
print(f"Validated torch {torch.__version__}, CUDA {torch.version.cuda}, {torch.cuda.device_count()} GPU(s)")
print("Validated ChatterboxTurboTTS import")
"""
    run([str(venv_python()), "-c", script], env=runtime_environment())


def prefetch_weights() -> None:
    script = """
from huggingface_hub import snapshot_download
path = snapshot_download(
    repo_id="ResembleAI/chatterbox-turbo",
    allow_patterns=["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"],
)
print(f"Chatterbox Turbo weights cached at {path}")
"""
    print("Prefetching Chatterbox Turbo model weights...")
    run([str(venv_python()), "-c", script], env=runtime_environment())


def install_voice(voice: str | None) -> str:
    if not voice:
        return ""
    voice_path = Path(voice).expanduser().resolve(strict=True)
    if not voice_path.is_file() or voice_path.suffix.lower() not in {".wav", ".flac", ".mp3", ".ogg", ".m4a"}:
        raise RuntimeError(f"--voice must point to a supported audio file: {voice_path}")
    destination = VOICES / voice_path.name
    if voice_path != destination:
        shutil.copy2(voice_path, destination)
    return destination.name


def write_versions() -> None:
    versions = {
        "python": output([str(venv_python()), "--version"]),
        "pytorch": output([str(venv_python()), "-c", "import torch; print(torch.__version__)"]),
        "chatterboxTts": CHATTERBOX_VERSION,
        "onnxruntime": ONNXRUNTIME_VERSION,
        "pytorchIndex": PYTORCH_INDEX,
        "worker": str((ROOT.parents[1] / "controller" / "scripts" / "chatterbox_worker.py").resolve()),
    }
    (RUNTIME / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the Windows Chatterbox Turbo runtime")
    parser.add_argument("--voice", help="reference voice to copy into voices/")
    parser.add_argument("--skip-weights", action="store_true", help="do not prefetch model weights")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        require_python_311()
        ensure_directories()
        ensure_venv()
        install_python_dependencies()
        validate_python_runtime()
        if not args.skip_weights:
            prefetch_weights()
        installed_voice = install_voice(args.voice)
        write_versions()
    except Exception as error:
        print(f"\nSETUP FAILED: {error}", file=sys.stderr)
        return 1

    print("\nChatterbox Turbo is installed.")
    print(f"  Python venv: {VENV}")
    print(f"  Model cache: {HF_CACHE}")
    print(f"  Voices: {VOICES}")
    if installed_voice:
        print(f"  Installed voice: {installed_voice}")
    elif not any(path.is_file() for path in VOICES.iterdir()):
        print("  Optional cloned voice: put a >5-second narrator recording in voices/")
    print("\nFor normal day-to-day use, double-click:")
    print("  start-chatterbox-turbo.bat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
