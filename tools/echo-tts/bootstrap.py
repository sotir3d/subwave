"""One-time Windows bootstrap for the local SUB/WAVE AI services.

Creates a repo-local Python 3.11 venv, installs a CUDA-enabled Echo runtime,
checks out a pinned Echo revision, prefetches its model weights, installs a
pinned CUDA llama.cpp binary, and creates the machine-local service config.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
RUNTIME = ROOT / ".runtime"
ECHO_REPO = RUNTIME / "echo-tts"
HF_CACHE = RUNTIME / "hf-cache"
LLAMA_DIR = RUNTIME / "llama.cpp"
DOWNLOADS = RUNTIME / "downloads"
MODELS = ROOT / "models"
VOICES = ROOT / "voices"
CONFIG = ROOT / "windows-ai.json"
CONFIG_EXAMPLE = ROOT / "windows-ai.example.json"
REQUIREMENTS = ROOT / "requirements.txt"

ECHO_REVISION = "2ed95fce62d33bf7b56f835fd9ec0f0b6fb9155e"
LLAMA_RELEASE = "b10189"
LLAMA_ARCHIVE = f"llama-{LLAMA_RELEASE}-bin-win-cuda-12.4-x64.zip"
CUDART_ARCHIVE = "cudart-llama-bin-win-cuda-12.4-x64.zip"
LLAMA_BASE_URL = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE}"
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
    for directory in (RUNTIME, HF_CACHE, DOWNLOADS, MODELS, VOICES):
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
    # Windows PyPI resolves torch to a CPU wheel. Use PyTorch's CUDA index
    # explicitly so Echo can actually run on the assigned RTX 3090.
    run([
        python, "-m", "pip", "install", "--upgrade",
        f"torch=={PYTORCH_VERSION}", f"torchaudio=={PYTORCH_VERSION}",
        "--index-url", PYTORCH_INDEX,
    ])
    # TorchCodec publishes its Windows wheel on PyPI, not the PyTorch index.
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


def resolve_ffmpeg_directory(config: dict, requested: str | None) -> Path:
    echo = config.setdefault("echo", {})
    if not isinstance(echo, dict):
        raise RuntimeError("echo config must be a JSON object")

    candidates: list[str | Path] = []
    if requested:
        candidates.append(requested)
    configured = echo.get("ffmpegDirectory", "")
    if isinstance(configured, str) and configured.strip():
        candidates.append(configured)
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
            echo["ffmpegDirectory"] = str(directory)
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


def prefetch_echo_weights() -> None:
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
    env = os.environ.copy()
    env["HF_HOME"] = str(HF_CACHE)
    run([str(venv_python()), "-c", script], env=env)


def download(url: str, destination: Path) -> None:
    if destination.is_file() and destination.stat().st_size > 0:
        print(f"Using cached download: {destination.name}")
        return
    print(f"Downloading {url}")
    temporary = destination.with_suffix(destination.suffix + ".partial")
    request = urllib.request.Request(url, headers={"User-Agent": "subwave-windows-ai-bootstrap/1"})
    with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output_file:
        total = int(response.headers.get("Content-Length", "0") or "0")
        received = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output_file.write(chunk)
            received += len(chunk)
            if total:
                print(f"  {received / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MiB", end="\r", flush=True)
    if total:
        print()
    temporary.replace(destination)


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    destination_root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            target = (destination / member.filename).resolve()
            try:
                target.relative_to(destination_root)
            except ValueError as error:
                raise RuntimeError(f"unsafe path in {archive.name}: {member.filename}") from error
        bundle.extractall(destination)


def ensure_llama_cpp() -> None:
    server = LLAMA_DIR / "llama-server.exe"
    if server.is_file():
        print(f"llama.cpp runtime already installed: {server}")
        return
    llama_zip = DOWNLOADS / LLAMA_ARCHIVE
    cudart_zip = DOWNLOADS / CUDART_ARCHIVE
    download(f"{LLAMA_BASE_URL}/{LLAMA_ARCHIVE}", llama_zip)
    download(f"{LLAMA_BASE_URL}/{CUDART_ARCHIVE}", cudart_zip)

    with tempfile.TemporaryDirectory(dir=RUNTIME, prefix="llama-extract-") as temp:
        extracted = Path(temp)
        safe_extract(llama_zip, extracted)
        safe_extract(cudart_zip, extracted)
        candidates = list(extracted.rglob("llama-server.exe"))
        if len(candidates) != 1:
            raise RuntimeError(f"expected one llama-server.exe in {llama_zip.name}; found {len(candidates)}")
        binary_dir = candidates[0].parent
        LLAMA_DIR.mkdir(parents=True, exist_ok=True)
        for source in binary_dir.iterdir():
            if source.is_file():
                shutil.copy2(source, LLAMA_DIR / source.name)
        # CUDA runtime assets may be at a different level than the executables.
        for dll in extracted.rglob("*.dll"):
            target = LLAMA_DIR / dll.name
            if not target.exists():
                shutil.copy2(dll, target)
    if not server.is_file():
        raise RuntimeError("llama.cpp extraction completed without llama-server.exe")
    print(f"llama.cpp {LLAMA_RELEASE} installed at {LLAMA_DIR}")


def load_or_create_config() -> dict:
    if CONFIG.is_file():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return json.loads(CONFIG_EXAMPLE.read_text(encoding="utf-8"))


def configure_local_files(config: dict, model: str | None, voice: str | None) -> None:
    if model:
        model_path = Path(model).expanduser().resolve(strict=True)
        if not model_path.is_file() or model_path.suffix.lower() != ".gguf":
            raise RuntimeError(f"--model must point to a GGUF file: {model_path}")
        config["llama"]["model"] = str(model_path)
    if voice:
        voice_path = Path(voice).expanduser().resolve(strict=True)
        if not voice_path.is_file() or voice_path.suffix.lower() not in {".wav", ".flac", ".mp3", ".ogg", ".m4a"}:
            raise RuntimeError(f"--voice must point to a supported audio file: {voice_path}")
        destination = VOICES / voice_path.name
        if voice_path != destination:
            shutil.copy2(voice_path, destination)
        config["echo"]["defaultVoice"] = destination.name
    CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def write_versions(ffmpeg_directory: Path) -> None:
    ffmpeg_version = output([str(ffmpeg_directory / "ffmpeg.exe"), "-version"]).splitlines()[0]
    versions = {
        "python": output([str(venv_python()), "--version"]),
        "pytorch": output([str(venv_python()), "-c", "import torch; print(torch.__version__)"]),
        "torchCodec": TORCHCODEC_VERSION,
        "ffmpeg": ffmpeg_version,
        "echoRevision": ECHO_REVISION,
        "llamaRelease": LLAMA_RELEASE,
    }
    (RUNTIME / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the Windows llama.cpp + Echo-TTS runtime")
    parser.add_argument("--model", help="existing GGUF model path to store in windows-ai.json")
    parser.add_argument("--voice", help="reference voice to copy into voices/ and select")
    parser.add_argument("--ffmpeg-dir", help="shared FFmpeg directory (root, bin directory, or ffmpeg.exe)")
    parser.add_argument("--skip-llama", action="store_true", help="do not download the pinned llama.cpp runtime")
    parser.add_argument("--skip-weights", action="store_true", help="do not prefetch Echo model weights")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        require_python_311()
        ensure_directories()
        ensure_venv()
        ensure_echo_checkout()
        config = load_or_create_config()
        ffmpeg_directory = resolve_ffmpeg_directory(config, args.ffmpeg_dir)
        install_python_dependencies()
        validate_python_runtime(ffmpeg_directory)
        if not args.skip_weights:
            prefetch_echo_weights()
        if not args.skip_llama:
            ensure_llama_cpp()
        configure_local_files(config, args.model, args.voice)
        write_versions(ffmpeg_directory)
    except Exception as error:
        print(f"\nSETUP FAILED: {error}", file=sys.stderr)
        return 1

    print("\nWindows AI runtime is installed.")
    print(f"  Python venv: {VENV}")
    print(f"  Echo checkout: {ECHO_REPO}")
    print(f"  llama.cpp: {LLAMA_DIR}")
    print(f"  Config: {CONFIG}")
    print(f"  Models: {MODELS}")
    print(f"  Voices: {VOICES}")
    model = config.get("llama", {}).get("model", "")
    voice = config.get("echo", {}).get("defaultVoice", "")
    if model:
        print(f"  Configured model: {model}")
    else:
        print("  Model still needed: put one GGUF in models/ or re-run with --model")
    if voice:
        print(f"  Configured voice: {voice}")
    else:
        print("  Voice still needed: put one recording in voices/ or re-run with --voice")
    print("\nFor normal day-to-day use, double-click:")
    print("  start-windows-ai.bat")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
