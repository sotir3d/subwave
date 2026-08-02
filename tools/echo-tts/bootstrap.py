"""One-time Windows bootstrap for SUB/WAVE's Echo-TTS service.

Creates a repo-local Python 3.11 virtual environment, installs CUDA-enabled
Echo inference dependencies, checks out a pinned Echo revision, prefetches its
weights, and optionally installs a narrator reference. It deliberately knows
nothing about the operator's LLM server.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
RUNTIME = ROOT / ".runtime"
ECHO_REPO = RUNTIME / "echo-tts"
HF_CACHE = RUNTIME / "hf-cache"
VOICES = ROOT / "voices"
REQUIREMENTS = ROOT / "requirements.txt"

ECHO_REVISION = "2ed95fce62d33bf7b56f835fd9ec0f0b6fb9155e"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu128"
PYTORCH_VERSION = "2.9.1"
TORCHCODEC_VERSION = "0.9.1"


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print(f"> {' '.join(command)}", flush=True)
    completed = subprocess.run(command, cwd=cwd, env=env, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"command exited {completed.returncode}: {command[0]}")


def output(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
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


def ensure_echo_checkout() -> None:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("Git was not found on PATH")
    if not ECHO_REPO.exists():
        run([git, "clone", "https://github.com/jordandare/echo-tts.git", str(ECHO_REPO)])
    if not (ECHO_REPO / ".git").is_dir():
        raise RuntimeError(f"existing Echo path is not a Git checkout: {ECHO_REPO}")
    dirty = output([git, "status", "--porcelain"], cwd=ECHO_REPO)
    if dirty:
        raise RuntimeError(f"generated Echo checkout has local changes; refusing to overwrite {ECHO_REPO}")
    head = output([git, "rev-parse", "HEAD"], cwd=ECHO_REPO)
    if head != ECHO_REVISION:
        run([git, "fetch", "--depth", "1", "origin", ECHO_REVISION], cwd=ECHO_REPO)
        run([git, "checkout", "--detach", ECHO_REVISION], cwd=ECHO_REPO)
    print(f"Echo-TTS revision: {ECHO_REVISION}")


def install_python_dependencies() -> None:
    python = str(venv_python())
    run([python, "-m", "pip", "install", "--upgrade", "pip"])
    # Generic PyPI can resolve torch to a CPU wheel on Windows. Keep the CUDA
    # stack on PyTorch's CUDA index, then install TorchCodec from PyPI.
    run([
        python, "-m", "pip", "install", "--upgrade",
        f"torch=={PYTORCH_VERSION}", f"torchaudio=={PYTORCH_VERSION}",
        "--index-url", PYTORCH_INDEX,
    ])
    run([python, "-m", "pip", "install", "--upgrade", f"torchcodec=={TORCHCODEC_VERSION}"])
    run([python, "-m", "pip", "install", "-r", str(REQUIREMENTS)])


def _normalise_ffmpeg_directory(value: str | Path) -> Path:
    candidate = Path(value).expanduser()
    if candidate.is_file() and candidate.name.lower() == "ffmpeg.exe":
        candidate = candidate.parent
    if (candidate / "bin" / "ffmpeg.exe").is_file():
        candidate = candidate / "bin"
    return candidate.resolve()


def _shared_ffmpeg(directory: Path) -> bool:
    required = ("avcodec-*.dll", "avformat-*.dll", "avutil-*.dll", "swresample-*.dll")
    return (directory / "ffmpeg.exe").is_file() and all(any(directory.glob(pattern)) for pattern in required)


def resolve_ffmpeg_directory(requested: str | None) -> Path:
    candidates: list[str | Path] = []
    if requested:
        candidates.append(requested)
    on_path = shutil.which("ffmpeg")
    if on_path:
        candidates.append(on_path)
    candidates.append(Path("C:/ffmpeg/bin"))

    checked: list[Path] = []
    for value in candidates:
        directory = _normalise_ffmpeg_directory(value)
        if directory in checked:
            continue
        checked.append(directory)
        if _shared_ffmpeg(directory):
            print(f"Shared FFmpeg runtime: {directory}")
            return directory

    where = ", ".join(str(path) for path in checked) or "no candidate paths"
    raise RuntimeError(
        "TorchCodec needs a shared FFmpeg build (ffmpeg.exe plus avcodec/avformat/avutil DLLs). "
        f"Checked: {where}. Pass --ffmpeg-dir C:\\path\\to\\ffmpeg."
    )


def echo_environment(ffmpeg_directory: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(ffmpeg_directory) + os.pathsep + env.get("PATH", "")
    env["HF_HOME"] = str(HF_CACHE)
    env["PYTHONPATH"] = str(ECHO_REPO)
    return env


def validate_python_runtime(ffmpeg_directory: Path) -> None:
    script = """
import torch
from torchcodec.decoders import AudioDecoder
import inference
if not torch.version.cuda:
    raise RuntimeError(f"CPU-only PyTorch was installed: {torch.__version__}")
if not torch.cuda.is_available():
    raise RuntimeError("PyTorch cannot see an NVIDIA CUDA device")
print(f"Validated torch {torch.__version__}, CUDA {torch.version.cuda}, {torch.cuda.device_count()} GPU(s)")
print("Validated TorchCodec and pinned Echo imports")
"""
    run([str(venv_python()), "-c", script], env=echo_environment(ffmpeg_directory))


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


def write_versions(ffmpeg_directory: Path) -> None:
    ffmpeg_version = output([str(ffmpeg_directory / "ffmpeg.exe"), "-version"]).splitlines()[0]
    versions = {
        "python": output([str(venv_python()), "--version"]),
        "pytorch": output([str(venv_python()), "-c", "import torch; print(torch.__version__)"]),
        "torchCodec": TORCHCODEC_VERSION,
        "ffmpeg": ffmpeg_version,
        "echoRevision": ECHO_REVISION,
    }
    (RUNTIME / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the Windows Echo-TTS runtime")
    parser.add_argument("--voice", help="reference voice to copy into voices/")
    parser.add_argument("--ffmpeg-dir", help="shared FFmpeg directory (root, bin directory, or ffmpeg.exe)")
    parser.add_argument("--skip-weights", action="store_true", help="do not prefetch Echo model weights")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        require_python_311()
        ensure_directories()
        ensure_venv()
        ensure_echo_checkout()
        ffmpeg_directory = resolve_ffmpeg_directory(args.ffmpeg_dir)
        install_python_dependencies()
        validate_python_runtime(ffmpeg_directory)
        if not args.skip_weights:
            # HF_HOME is the only part of echo_environment needed here, but use
            # the validated shared FFmpeg path for one consistent environment.
            env = echo_environment(ffmpeg_directory)
            print("Prefetching Echo-TTS and Fish S1-DAC model weights...")
            script = """
from huggingface_hub import hf_hub_download
files = (
    ("jordand/echo-tts-base", "pytorch_model.safetensors"),
    ("jordand/echo-tts-base", "pca_state.safetensors"),
    ("jordand/fish-s1-dac-min", "pytorch_model.safetensors"),
)
for repo, filename in files:
    print(f"  {repo}/{filename}", flush=True)
    hf_hub_download(repo, filename)
"""
            run([str(venv_python()), "-c", script], env=env)
        installed_voice = install_voice(args.voice)
        write_versions(ffmpeg_directory)
    except Exception as error:
        print(f"\nSETUP FAILED: {error}", file=sys.stderr)
        return 1

    print("\nEcho-TTS is installed.")
    print(f"  Python venv: {VENV}")
    print(f"  Echo checkout: {ECHO_REPO}")
    print(f"  Voices: {VOICES}")
    if installed_voice:
        print(f"  Installed voice: {installed_voice}")
    elif not any(path.is_file() for path in VOICES.iterdir()):
        print("  Voice still needed: put a narrator recording in voices/ or re-run with --voice")
    print("\nFor normal day-to-day use, double-click:")
    print("  start-echo-tts.bat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
