"""Windows-native Chatterbox Turbo bridge for SUB/WAVE's Remote TTS engine.

This process intentionally does not reimplement Chatterbox inference. It keeps
SUB/WAVE's existing controller/scripts/chatterbox_worker.py resident as a child
process and translates the generic remote HTTP contract to that worker's JSON
line protocol:

    GET  /health -> JSON capability/readiness metadata
    POST /speak  -> JSON {"text": "...", "voice": "narrator.wav"}
                    with a PCM WAV response body

Reusing the worker preserves the same sentence-aware long-input chunking,
reference conditioning, CUDA compatibility shim, stitching, and model version
as the local/sidecar Chatterbox path while inference remains on this Windows
GPU host. Only Python's standard library is used by the HTTP layer.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


LOG = logging.getLogger("subwave-chatterbox-turbo")
ENGINE_ID = "chatterbox-turbo"
MAX_REQUEST_BYTES = 256 * 1024
SUPPORTED_VOICE_SUFFIXES = (".wav", ".flac", ".mp3", ".ogg", ".m4a")
SAFE_VOICE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKER = REPO_ROOT / "controller" / "scripts" / "chatterbox_worker.py"


class ConfigurationError(RuntimeError):
    """The bridge cannot start with the supplied local configuration."""


class ServiceNotReady(RuntimeError):
    """The resident Chatterbox worker is still loading or has failed."""


class WorkerError(RuntimeError):
    """The resident Chatterbox worker rejected or lost a request."""


class VoiceError(ValueError):
    """A requested reference voice is absent, ambiguous, or unsafe."""


class RequestError(ValueError):
    """An HTTP request does not satisfy the bridge contract."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class BridgeConfig:
    worker_script: Path
    python: Path
    voice_dir: Path
    output_dir: Path
    default_voice: str
    listen_address: str
    port: int
    device: str
    request_timeout_seconds: int
    max_text_utf8_bytes: int
    max_seconds: int
    max_chunk_chars: int
    chunk_gap_ms: int
    hf_home: Path

    @classmethod
    def from_env(cls) -> "BridgeConfig":
        runtime = Path(__file__).resolve().parent / ".runtime"
        return cls(
            worker_script=Path(
                os.environ.get("CHATTERBOX_TTS_WORKER", str(DEFAULT_WORKER)),
            ).expanduser(),
            python=Path(os.environ.get("CHATTERBOX_TTS_PYTHON", sys.executable)).expanduser(),
            voice_dir=Path(
                os.environ.get(
                    "CHATTERBOX_TTS_VOICE_DIR",
                    str(Path(__file__).resolve().parent / "voices"),
                ),
            ).expanduser(),
            output_dir=Path(
                os.environ.get("CHATTERBOX_TTS_OUTPUT_DIR", str(runtime / "output")),
            ).expanduser(),
            default_voice=os.environ.get("CHATTERBOX_TTS_DEFAULT_VOICE", "").strip(),
            listen_address=os.environ.get(
                "CHATTERBOX_TTS_LISTEN_ADDRESS", "0.0.0.0",
            ).strip() or "0.0.0.0",
            port=_env_int("CHATTERBOX_TTS_PORT", 18766, 1, 65_535),
            device=os.environ.get("CHATTERBOX_DEVICE", "cuda").strip() or "cuda",
            request_timeout_seconds=_env_int(
                "CHATTERBOX_TTS_REQUEST_TIMEOUT_SECONDS", 600, 10, 3_600,
            ),
            max_text_utf8_bytes=_env_int(
                "CHATTERBOX_TTS_MAX_TEXT_UTF8_BYTES", 64 * 1024, 256, 1_000_000,
            ),
            # This is the HTTP service's assembled-output budget, not a single
            # model context. The reused worker safely splits each request into
            # <=max_chunk_chars inference calls before stitching them.
            max_seconds=_env_int("CHATTERBOX_TTS_MAX_SECONDS", 120, 10, 600),
            max_chunk_chars=_env_int("CHATTERBOX_MAX_CHUNK_CHARS", 280, 80, 1_000),
            chunk_gap_ms=_env_int("CHATTERBOX_CHUNK_GAP_MS", 160, 0, 2_000),
            hf_home=Path(os.environ.get("HF_HOME", str(runtime / "hf-cache"))).expanduser(),
        )

    def validate(self) -> None:
        if not self.python.is_file():
            raise ConfigurationError(f"Python interpreter not found: {self.python}")
        if not self.worker_script.is_file():
            raise ConfigurationError(f"SUB/WAVE Chatterbox worker not found: {self.worker_script}")


@dataclass(frozen=True)
class ResolvedVoice:
    path: Path | None
    response_id: str


class VoiceCatalog:
    """Resolve voice IDs inside one directory without accepting paths."""

    def __init__(self, root: Path, default_voice: str = ""):
        self.root = root
        self.default_voice = default_voice.strip()

    def list_ids(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(
            entry.name
            for entry in self.root.iterdir()
            if entry.is_file() and entry.suffix.lower() in SUPPORTED_VOICE_SUFFIXES
        )

    def resolve(self, requested: str) -> ResolvedVoice:
        requested = requested.strip()
        effective = requested or self.default_voice
        if not effective:
            # The official Turbo checkpoint includes a built-in conditioning
            # voice. It is useful for Settings -> Play sample and as an explicit
            # operator choice; named persona voices are still resolved strictly.
            return ResolvedVoice(path=None, response_id="builtin")

        if not SAFE_VOICE_ID.fullmatch(effective) or Path(effective).name != effective:
            raise VoiceError("voice must be a simple filename or filename stem")

        supplied = self.root / effective
        if supplied.suffix:
            if supplied.suffix.lower() not in SUPPORTED_VOICE_SUFFIXES:
                raise VoiceError(f"unsupported reference-audio type: {supplied.suffix}")
            candidates = [supplied]
        else:
            candidates = [self.root / f"{effective}{suffix}" for suffix in SUPPORTED_VOICE_SUFFIXES]

        existing = [candidate for candidate in candidates if candidate.is_file()]
        if not existing:
            raise VoiceError(f'reference voice "{effective}" was not found')
        if len(existing) > 1:
            raise VoiceError(f'reference voice "{effective}" is ambiguous; include its extension')

        root = self.root.resolve()
        resolved = existing[0].resolve()
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise VoiceError("reference voice resolves outside the configured voice directory") from error
        return ResolvedVoice(path=resolved, response_id=requested or effective)


class ChatterboxWorker:
    """Supervise and speak the existing SUB/WAVE JSON-line worker protocol."""

    def __init__(self, config: BridgeConfig):
        self.config = config
        self._state_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._process: subprocess.Popen[str] | None = None
        self._loading = False
        self._ready = False
        self._error = ""
        self._loaded_at: float | None = None

    def start(self) -> None:
        with self._state_lock:
            if self._loading or self._ready:
                return
            self._loading = True

        env = os.environ.copy()
        env.update({
            "CHATTERBOX_DEVICE": self.config.device,
            "CHATTERBOX_REFERENCE_WAV": "",
            "CHATTERBOX_MAX_CHUNK_CHARS": str(self.config.max_chunk_chars),
            "CHATTERBOX_CHUNK_GAP_MS": str(self.config.chunk_gap_ms),
            "HF_HOME": str(self.config.hf_home),
            "PYTHONUNBUFFERED": "1",
        })
        LOG.info("starting resident SUB/WAVE worker: %s", self.config.worker_script)
        try:
            process = subprocess.Popen(
                [str(self.config.python), str(self.config.worker_script)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
            )
        except Exception as error:
            self._mark_failed(f"could not start Chatterbox worker: {error}")
            return

        self._process = process
        threading.Thread(target=self._read_stdout, name="chatterbox-worker-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="chatterbox-worker-stderr", daemon=True).start()
        threading.Thread(target=self._watch_exit, name="chatterbox-worker-exit", daemon=True).start()

    def _read_stdout(self) -> None:
        process = self._process
        if not process or not process.stdout:
            return
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                LOG.warning("ignoring non-JSON worker stdout: %s", line)
                continue
            if message.get("ready") is True:
                with self._state_lock:
                    self._loading = False
                    self._ready = True
                    self._error = ""
                    self._loaded_at = time.time()
                LOG.info("Chatterbox Turbo worker is ready")
                continue
            if message.get("fatal") is True:
                self._mark_failed(str(message.get("error") or "worker failed during startup"))
                continue
            request_id = message.get("id")
            if not isinstance(request_id, str):
                LOG.warning("ignoring worker response without an id: %s", message)
                continue
            with self._pending_lock:
                response_queue = self._pending.get(request_id)
            if response_queue:
                response_queue.put(message)

    def _read_stderr(self) -> None:
        process = self._process
        if not process or not process.stderr:
            return
        for line in process.stderr:
            text = line.rstrip()
            if text:
                LOG.info("worker: %s", text)

    def _watch_exit(self) -> None:
        process = self._process
        if not process:
            return
        code = process.wait()
        self._mark_failed(f"Chatterbox worker exited with code {code}")

    def _mark_failed(self, message: str) -> None:
        with self._state_lock:
            self._loading = False
            self._ready = False
            self._error = message
        with self._pending_lock:
            pending = list(self._pending.values())
        for response_queue in pending:
            try:
                response_queue.put_nowait({"ok": False, "error": message, "fatal": True})
            except queue.Full:
                # A response won the race with process exit. The request thread
                # already has everything it needs, so failure notification must
                # not block the worker's exit watcher.
                pass
        LOG.error("%s", message)

    def status(self) -> tuple[bool, bool, str, float | None]:
        with self._state_lock:
            return self._ready, self._loading, self._error, self._loaded_at

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        ready, _loading, error, _loaded_at = self.status()
        if not ready:
            detail = f": {error}" if error else ""
            raise ServiceNotReady(f"Chatterbox Turbo is not ready{detail}")
        process = self._process
        if not process or not process.stdin or process.poll() is not None:
            raise ServiceNotReady("Chatterbox Turbo worker is not running")

        request_id = uuid.uuid4().hex
        response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = response_queue
        try:
            with self._write_lock:
                process.stdin.write(json.dumps({"id": request_id, **payload}, ensure_ascii=False) + "\n")
                process.stdin.flush()
            try:
                response = response_queue.get(timeout=self.config.request_timeout_seconds)
            except queue.Empty as error:
                raise WorkerError(
                    f"Chatterbox request timed out after {self.config.request_timeout_seconds}s",
                ) from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

        if not response.get("ok"):
            raise WorkerError(str(response.get("error") or "Chatterbox worker failed"))
        return response

    def stop(self) -> None:
        process = self._process
        self._process = None
        if not process or process.poll() is not None:
            return
        LOG.info("stopping Chatterbox Turbo worker")
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


@dataclass(frozen=True)
class SynthesisResult:
    wav: bytes
    voice_id: str
    duration_seconds: float


class ChatterboxEngine:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self.voices = VoiceCatalog(config.voice_dir, config.default_voice)
        self.worker = ChatterboxWorker(config)
        self._inference_lock = threading.Lock()

    def start_loading(self) -> None:
        self.worker.start()

    def health(self) -> dict[str, Any]:
        ready, loading, error, loaded_at = self.worker.status()
        body: dict[str, Any] = {
            "ok": True,
            "ready": ready,
            "engine": ENGINE_ID,
            "maxSeconds": self.config.max_seconds,
            "voices": self.voices.list_ids(),
            "modelReady": ready,
            "loading": loading,
            "device": self.config.device,
            "contract": "subwave-remote-tts-v1",
            "features": ["voice-cloning", "paralinguistic-tags", "longform-chunking"],
            "maxChunkChars": self.config.max_chunk_chars,
            "chunkGapMs": self.config.chunk_gap_ms,
            "builtinVoice": True,
        }
        if loaded_at is not None:
            body["loadedAt"] = loaded_at
        if error:
            body["error"] = error
        return body

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        text = text.strip()
        if not text:
            raise RequestError(HTTPStatus.BAD_REQUEST, "text must not be empty")
        size = len(text.encode("utf-8"))
        if size > self.config.max_text_utf8_bytes:
            raise RequestError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"text exceeds the service limit of {self.config.max_text_utf8_bytes} UTF-8 bytes",
            )
        resolved_voice = self.voices.resolve(voice)

        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        file_descriptor, temp_name = tempfile.mkstemp(
            prefix="chatterbox-", suffix=".wav", dir=self.config.output_dir,
        )
        os.close(file_descriptor)
        out_path = Path(temp_name)
        try:
            with self._inference_lock:
                LOG.info("rendering %d UTF-8 bytes with voice=%s", size, resolved_voice.response_id)
                response = self.worker.request({
                    "text": text,
                    "reference_wav": str(resolved_voice.path) if resolved_voice.path else "",
                    "out": str(out_path),
                })
            wav = out_path.read_bytes()
            if len(wav) < 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
                raise WorkerError("Chatterbox worker returned an invalid WAV")
            duration = float(response.get("duration_s") or 0.0)
            LOG.info("rendered %.2fs for voice=%s", duration, resolved_voice.response_id)
            return SynthesisResult(wav=wav, voice_id=resolved_voice.response_id, duration_seconds=duration)
        finally:
            try:
                out_path.unlink(missing_ok=True)
            except OSError:
                LOG.warning("could not remove temporary output %s", out_path)

    def stop(self) -> None:
        self.worker.stop()


class ChatterboxHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], engine: Any):
        self.engine = engine
        super().__init__(address, ChatterboxRequestHandler)


class ChatterboxRequestHandler(BaseHTTPRequestHandler):
    server: ChatterboxHttpServer
    protocol_version = "HTTP/1.1"
    server_version = "subwave-chatterbox-turbo/1"
    sys_version = ""

    def log_message(self, format_string: str, *args: Any) -> None:
        LOG.info("%s - %s", self.client_address[0], format_string % args)

    def _json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"ok": False, "error": message})

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if urlsplit(self.path).path != "/health":
            self._error(HTTPStatus.NOT_FOUND, "not found")
            return
        self._json(HTTPStatus.OK, self.server.engine.health())

    def _read_speak_request(self) -> tuple[str, str]:
        raw_length = self.headers.get("Content-Length", "")
        try:
            content_length = int(raw_length)
        except ValueError as error:
            raise RequestError(HTTPStatus.LENGTH_REQUIRED, "valid Content-Length is required") from error
        if content_length <= 0:
            raise RequestError(HTTPStatus.BAD_REQUEST, "request body is required")
        if content_length > MAX_REQUEST_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large")
        try:
            body = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RequestError(HTTPStatus.BAD_REQUEST, "request body must be valid JSON") from error
        if not isinstance(body, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
        text = body.get("text", "")
        voice = body.get("voice", "")
        if not isinstance(text, str) or not isinstance(voice, str):
            raise RequestError(HTTPStatus.BAD_REQUEST, "text and voice must be strings")
        return text, voice

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if urlsplit(self.path).path != "/speak":
            self._error(HTTPStatus.NOT_FOUND, "not found")
            return
        try:
            text, voice = self._read_speak_request()
            result = self.server.engine.synthesize(text, voice)
        except RequestError as error:
            self._error(error.status, str(error))
            return
        except VoiceError as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
            return
        except ServiceNotReady as error:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(error))
            return
        except Exception as error:
            LOG.exception("Chatterbox Turbo synthesis failed")
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Chatterbox Turbo synthesis failed: {error}")
            return

        self.close_connection = True
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(result.wav)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-TTS-Engine", ENGINE_ID)
        self.send_header("X-TTS-Voice-Used", result.voice_id)
        self.send_header("X-TTS-Fell-Back", "false")
        self.send_header("X-TTS-Duration-Seconds", f"{result.duration_seconds:.3f}")
        self.end_headers()
        try:
            self.wfile.write(result.wav)
        except (BrokenPipeError, ConnectionResetError):
            LOG.warning("client disconnected before the WAV response completed")


def build_server(listen_address: str, port: int, engine: Any) -> ChatterboxHttpServer:
    return ChatterboxHttpServer((listen_address, port), engine)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chatterbox Turbo bridge for SUB/WAVE")
    parser.add_argument("--listen-address", help="override CHATTERBOX_TTS_LISTEN_ADDRESS")
    parser.add_argument("--port", type=int, help="override CHATTERBOX_TTS_PORT")
    parser.add_argument("--worker", help="override CHATTERBOX_TTS_WORKER")
    parser.add_argument("--voice-dir", help="override CHATTERBOX_TTS_VOICE_DIR")
    parser.add_argument("--default-voice", help="override CHATTERBOX_TTS_DEFAULT_VOICE")
    parser.add_argument("--device", help="override CHATTERBOX_DEVICE")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    overrides = {
        "CHATTERBOX_TTS_LISTEN_ADDRESS": args.listen_address,
        "CHATTERBOX_TTS_PORT": str(args.port) if args.port is not None else None,
        "CHATTERBOX_TTS_WORKER": args.worker,
        "CHATTERBOX_TTS_VOICE_DIR": args.voice_dir,
        "CHATTERBOX_TTS_DEFAULT_VOICE": args.default_voice,
        "CHATTERBOX_DEVICE": args.device,
    }
    for key, value in overrides.items():
        if value is not None:
            os.environ[key] = value

    logging.basicConfig(
        level=os.environ.get("CHATTERBOX_TTS_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )
    try:
        config = BridgeConfig.from_env()
        config.validate()
        for directory in (config.voice_dir, config.output_dir, config.hf_home):
            directory.mkdir(parents=True, exist_ok=True)
        engine = ChatterboxEngine(config)
        server = build_server(config.listen_address, config.port, engine)
    except Exception as error:
        LOG.error("cannot start Chatterbox Turbo bridge: %s", error)
        return 2

    engine.start_loading()
    LOG.info("HTTP bridge listening on http://%s:%d", config.listen_address, config.port)
    LOG.info("health remains ready=false until the resident Turbo worker has loaded")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        LOG.info("shutdown requested")
    finally:
        server.server_close()
        engine.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
