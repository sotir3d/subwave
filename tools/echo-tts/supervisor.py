"""Single-console supervisor for Windows llama.cpp and Echo-TTS.

Invoked by start-windows-ai.bat. It validates all local paths before starting
anything, applies the configured GPU visibility/split, prefixes and records
child logs, waits for both health endpoints, and tears both processes down on
Ctrl+C or if either child exits unexpectedly.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "windows-ai.json"
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
ECHO_SERVER = ROOT / "server.py"
ECHO_REPO = ROOT / ".runtime" / "echo-tts"
HF_CACHE = ROOT / ".runtime" / "hf-cache"
LOG_DIR = ROOT / ".runtime" / "logs"
VOICE_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}


class ConfigurationError(RuntimeError):
    pass


def _resolve(value: str, *, base: Path = ROOT) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else base / path


def _integer(block: dict[str, Any], key: str, minimum: int, maximum: int) -> int:
    value = block.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ConfigurationError(f"{key} must be an integer from {minimum} to {maximum}")
    return value


def _string(block: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = block.get(key)
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ConfigurationError(f"{key} must be a string")
    return value.strip()


def _enabled(block: Any, name: str) -> bool:
    if not isinstance(block, dict):
        raise ConfigurationError(f"{name} config must be an object")
    value = block.get("enabled", True)
    if not isinstance(value, bool):
        raise ConfigurationError(f"{name}.enabled must be true or false")
    return value


def _free_port(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.25)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def _pick_model(block: dict[str, Any]) -> Path:
    configured = _string(block, "model", allow_empty=True)
    if configured:
        model = _resolve(configured)
        if not model.is_file():
            raise ConfigurationError(f"configured GGUF model does not exist: {model}")
        if model.suffix.lower() != ".gguf":
            raise ConfigurationError(f"configured model is not a GGUF file: {model}")
        return model.resolve()

    model_dir = _resolve(_string(block, "modelDirectory"))
    models = sorted(path.resolve() for path in model_dir.rglob("*.gguf") if path.is_file()) if model_dir.is_dir() else []
    if not models:
        raise ConfigurationError(
            f"no GGUF model configured; put one in {model_dir} or set llama.model in windows-ai.json",
        )
    if len(models) > 1:
        choices = "\n  ".join(str(path) for path in models[:10])
        raise ConfigurationError(f"more than one GGUF was found; set llama.model explicitly:\n  {choices}")
    return models[0]


def _pick_voice(block: dict[str, Any]) -> tuple[Path, str]:
    voice_dir = _resolve(_string(block, "voiceDirectory"))
    if not voice_dir.is_dir():
        raise ConfigurationError(f"voice directory does not exist: {voice_dir}")
    requested = _string(block, "defaultVoice", allow_empty=True)
    voices = sorted(path for path in voice_dir.iterdir() if path.is_file() and path.suffix.lower() in VOICE_SUFFIXES)
    if requested:
        exact = voice_dir / requested
        if exact.is_file() and exact.suffix.lower() in VOICE_SUFFIXES:
            return voice_dir.resolve(), requested
        if not Path(requested).suffix:
            matches = [path for path in voices if path.stem == requested]
            if len(matches) == 1:
                return voice_dir.resolve(), requested
        raise ConfigurationError(f'configured Echo voice "{requested}" was not found in {voice_dir}')
    if len(voices) == 1:
        return voice_dir.resolve(), voices[0].name
    if not voices:
        raise ConfigurationError(f"no narrator reference was found in {voice_dir}")
    raise ConfigurationError("more than one Echo voice exists; set echo.defaultVoice in windows-ai.json")


def _pick_ffmpeg(block: dict[str, Any]) -> Path:
    configured = _string(block, "ffmpegDirectory", allow_empty=True)
    candidates: list[Path] = []
    if configured:
        candidates.append(_resolve(configured))
    on_path = shutil.which("ffmpeg")
    if on_path:
        candidates.append(Path(on_path).parent)
    candidates.append(Path("C:/ffmpeg/bin"))
    for candidate in candidates:
        if (candidate / "bin" / "ffmpeg.exe").is_file():
            candidate = candidate / "bin"
        required = ("avcodec-*.dll", "avformat-*.dll", "avutil-*.dll", "swresample-*.dll")
        if (candidate / "ffmpeg.exe").is_file() and all(any(candidate.glob(pattern)) for pattern in required):
            return candidate.resolve()
    raise ConfigurationError(
        "Echo needs a shared FFmpeg build; run setup-windows.bat or set echo.ffmpegDirectory",
    )


@dataclass(frozen=True)
class ServiceSpec:
    name: str
    command: list[str]
    environment: dict[str, str]
    health_url: str
    health_kind: str
    port: int


def load_specs(config_path: Path = DEFAULT_CONFIG) -> list[ServiceSpec]:
    if not config_path.is_file():
        raise ConfigurationError(f"missing {config_path.name}; run setup-windows.bat first")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise ConfigurationError(f"cannot read {config_path}: {error}") from error
    if not isinstance(config, dict):
        raise ConfigurationError("windows-ai.json must contain a JSON object")

    specs: list[ServiceSpec] = []
    llama = config.get("llama", {})
    if _enabled(llama, "llama"):
        executable = _resolve(_string(llama, "executable")).resolve()
        if not executable.is_file():
            raise ConfigurationError(f"llama-server.exe does not exist: {executable}; run setup-windows.bat")
        model = _pick_model(llama)
        port = _integer(llama, "port", 1, 65_535)
        extra = llama.get("extraArgs", [])
        if not isinstance(extra, list) or not all(isinstance(value, str) for value in extra):
            raise ConfigurationError("llama.extraArgs must be an array of strings")
        command = [
            str(executable),
            "-m", str(model),
            "--host", _string(llama, "listenAddress"),
            "--port", str(port),
            "--alias", _string(llama, "alias"),
            "--parallel", str(_integer(llama, "parallel", 1, 64)),
            "-c", str(_integer(llama, "contextSize", 512, 1_048_576)),
            "-ngl", str(_integer(llama, "gpuLayers", 0, 9_999)),
            "--jinja",
            *extra,
        ]
        env = os.environ.copy()
        env["CUDA_VISIBLE_DEVICES"] = _string(llama, "gpuDevice")
        specs.append(ServiceSpec("llama", command, env, f"http://127.0.0.1:{port}/health", "http", port))

    echo = config.get("echo", {})
    if _enabled(echo, "echo"):
        if not VENV_PYTHON.is_file():
            raise ConfigurationError(f"Echo virtual environment does not exist: {VENV_PYTHON}; run setup-windows.bat")
        if not (ECHO_REPO / "inference.py").is_file():
            raise ConfigurationError(f"pinned Echo checkout is missing: {ECHO_REPO}; run setup-windows.bat")
        ffmpeg_directory = _pick_ffmpeg(echo)
        voice_dir, voice_id = _pick_voice(echo)
        port = _integer(echo, "port", 1, 65_535)
        sequence_length = _integer(echo, "sequenceLength", 64, 640)
        env = os.environ.copy()
        env["PATH"] = str(ffmpeg_directory) + os.pathsep + env.get("PATH", "")
        env.update({
            "CUDA_VISIBLE_DEVICES": _string(echo, "gpuDevice"),
            "ECHO_TTS_DEVICE": "cuda",
            "ECHO_TTS_REPO": str(ECHO_REPO.resolve()),
            "ECHO_TTS_VOICE_DIR": str(voice_dir),
            "ECHO_TTS_DEFAULT_VOICE": voice_id,
            "ECHO_TTS_LISTEN_ADDRESS": _string(echo, "listenAddress"),
            "ECHO_TTS_PORT": str(port),
            "ECHO_TTS_SEQUENCE_LENGTH": str(sequence_length),
            "HF_HOME": str(HF_CACHE.resolve()),
            "PYTHONUNBUFFERED": "1",
        })
        specs.append(
            ServiceSpec(
                "echo",
                [str(VENV_PYTHON.resolve()), str(ECHO_SERVER.resolve())],
                env,
                f"http://127.0.0.1:{port}/health",
                "echo",
                port,
            ),
        )

    if not specs:
        raise ConfigurationError("both llama and Echo are disabled")
    ports = [spec.port for spec in specs]
    if len(ports) != len(set(ports)):
        raise ConfigurationError("llama and Echo cannot use the same port")
    return specs


class ConsoleLog:
    def __init__(self):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.path = LOG_DIR / f"windows-ai-{stamp}.log"
        self.file = self.path.open("a", encoding="utf-8", buffering=1)
        self.lock = threading.Lock()

    def write(self, name: str, line: str) -> None:
        rendered = f"[{name}] {line.rstrip()}"
        with self.lock:
            print(rendered, flush=True)
            self.file.write(rendered + "\n")

    def close(self) -> None:
        with self.lock:
            self.file.close()


class ManagedProcess:
    def __init__(self, spec: ServiceSpec, console: ConsoleLog):
        self.spec = spec
        self.console = console
        self.process: subprocess.Popen[str] | None = None
        self.reader: threading.Thread | None = None

    def start(self) -> None:
        self.console.write("manager", f"starting {self.spec.name}: {shlex.join(self.spec.command)}")
        self.process = subprocess.Popen(
            self.spec.command,
            env=self.spec.environment,
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.reader = threading.Thread(target=self._pump, name=f"{self.spec.name}-log", daemon=True)
        self.reader.start()

    def _pump(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            self.console.write(self.spec.name, line)

    def poll(self) -> int | None:
        return self.process.poll() if self.process else None

    def stop(self) -> None:
        if not self.process or self.process.poll() is not None:
            return
        self.console.write("manager", f"stopping {self.spec.name}")
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.console.write("manager", f"force-killing {self.spec.name}")
            self.process.kill()
            self.process.wait(timeout=5)


def _health(spec: ServiceSpec) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(spec.health_url, timeout=1.5) as response:
            if response.status != 200:
                return False, f"HTTP {response.status}"
            if spec.health_kind == "echo":
                body = json.load(response)
                if body.get("ready") is True:
                    return True, "ready"
                return False, str(body.get("error") or ("loading" if body.get("loading") else "not ready"))
            return True, "ready"
    except urllib.error.HTTPError as error:
        return False, f"HTTP {error.code}"
    except (OSError, ValueError):
        return False, "starting"


def run_services(specs: list[ServiceSpec]) -> int:
    occupied = [spec for spec in specs if not _free_port(spec.port)]
    if occupied:
        details = ", ".join(f"{spec.name}:{spec.port}" for spec in occupied)
        raise ConfigurationError(f"configured port is already in use: {details}")

    console = ConsoleLog()
    processes = [ManagedProcess(spec, console) for spec in specs]
    ready: set[str] = set()
    details: dict[str, str] = {}
    announced = False
    exit_code = 0
    console.write("manager", f"combined log: {console.path}")
    try:
        for process in processes:
            process.start()
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    console.write("manager", f"{process.spec.name} exited with code {code}")
                    exit_code = code or 1
                    return exit_code
                healthy, detail = _health(process.spec)
                if healthy and process.spec.name not in ready:
                    ready.add(process.spec.name)
                    console.write("manager", f"{process.spec.name} is ready at {process.spec.health_url}")
                elif not healthy:
                    ready.discard(process.spec.name)
                    if details.get(process.spec.name) != detail:
                        details[process.spec.name] = detail
                        console.write("manager", f"waiting for {process.spec.name}: {detail}")
            if len(ready) == len(processes) and not announced:
                console.write("manager", "all Windows AI services are ready; press Ctrl+C to stop both")
                announced = True
            elif len(ready) != len(processes):
                announced = False
            time.sleep(1.0)
    except KeyboardInterrupt:
        console.write("manager", "Ctrl+C received")
        return 0
    finally:
        for process in reversed(processes):
            process.stop()
        console.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Windows llama.cpp and Echo-TTS together")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--check", action="store_true", help="validate configuration without starting services")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        specs = load_specs(args.config.resolve())
        if args.check:
            for spec in specs:
                print(f"{spec.name}: {' '.join(spec.command)}")
                print(f"  health: {spec.health_url}")
            print("Configuration is valid.")
            return 0
        return run_services(specs)
    except ConfigurationError as error:
        print(f"CONFIGURATION ERROR: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"STARTUP ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
