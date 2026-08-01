"""Windows-native Echo-TTS bridge for SUB/WAVE's Remote TTS engine.

The upstream Echo-TTS repository exposes a Python inference API and a Gradio
demo, but no stable machine-to-machine HTTP API.  This process loads Echo once,
keeps it resident on the selected GPU, and implements SUB/WAVE's small remote
contract:

    GET  /health -> JSON capability/readiness metadata
    POST /speak  -> JSON {"text": "...", "voice": "narrator.wav"}
                    with an uncompressed PCM WAV response body

Only Python's standard library is used for HTTP serving. Echo-TTS' own Python
environment supplies torch and the upstream inference modules.
"""

from __future__ import annotations

import argparse
import importlib
import io
import json
import logging
import os
import re
import sys
import threading
import time
import wave
from dataclasses import dataclass
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


LOG = logging.getLogger("subwave-echo-tts")
ENGINE_ID = "echotts"
SAMPLE_RATE = 44_100
MAX_REQUEST_BYTES = 64 * 1024
SUPPORTED_VOICE_SUFFIXES = (".wav", ".flac", ".mp3", ".ogg", ".m4a")
SAFE_VOICE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")


class ConfigurationError(RuntimeError):
    """The bridge cannot start with the supplied local configuration."""


class ServiceNotReady(RuntimeError):
    """Echo is still loading or failed to load."""


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


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _optional_env_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number when set") from error


@dataclass(frozen=True)
class BridgeConfig:
    echo_repo: Path
    voice_dir: Path
    default_voice: str
    listen_address: str
    port: int
    device: str
    model_dtype: str
    fish_dtype: str
    sequence_length: int
    max_text_utf8_bytes: int
    num_steps: int
    cfg_scale_text: float
    cfg_scale_speaker: float
    cfg_min_t: float
    cfg_max_t: float
    truncation_factor: float
    rescale_k: float | None
    rescale_sigma: float | None
    speaker_kv_scale: float | None
    speaker_kv_min_t: float | None
    seed: int

    @property
    def max_seconds(self) -> float:
        # Echo was trained with 640 acoustic latents representing about 30 s.
        return round(30.0 * self.sequence_length / 640.0, 2)

    @classmethod
    def from_env(cls) -> "BridgeConfig":
        repo_value = os.environ.get("ECHO_TTS_REPO", "").strip()
        if not repo_value:
            raise ConfigurationError("ECHO_TTS_REPO must point to the upstream Echo-TTS checkout")
        voice_value = os.environ.get("ECHO_TTS_VOICE_DIR", "").strip()
        if not voice_value:
            raise ConfigurationError("ECHO_TTS_VOICE_DIR must point to the reference-voice directory")

        sequence_length = _env_int("ECHO_TTS_SEQUENCE_LENGTH", 640, 64, 640)
        speaker_scale = _optional_env_float("ECHO_TTS_SPEAKER_KV_SCALE")
        speaker_min_t = _optional_env_float("ECHO_TTS_SPEAKER_KV_MIN_T")
        if (speaker_scale is None) != (speaker_min_t is None):
            raise ConfigurationError(
                "ECHO_TTS_SPEAKER_KV_SCALE and ECHO_TTS_SPEAKER_KV_MIN_T must be set together",
            )
        if speaker_scale is not None and speaker_scale <= 0:
            raise ConfigurationError("ECHO_TTS_SPEAKER_KV_SCALE must be greater than zero")
        if speaker_min_t is not None and not 0.0 <= speaker_min_t <= 1.0:
            raise ConfigurationError("ECHO_TTS_SPEAKER_KV_MIN_T must be between zero and one")
        cfg_min_t = _env_float("ECHO_TTS_CFG_MIN_T", 0.5, 0.0, 1.0)
        cfg_max_t = _env_float("ECHO_TTS_CFG_MAX_T", 1.0, 0.0, 1.0)
        if cfg_min_t > cfg_max_t:
            raise ConfigurationError("ECHO_TTS_CFG_MIN_T must not exceed ECHO_TTS_CFG_MAX_T")

        return cls(
            echo_repo=Path(repo_value).expanduser(),
            voice_dir=Path(voice_value).expanduser(),
            default_voice=os.environ.get("ECHO_TTS_DEFAULT_VOICE", "").strip(),
            listen_address=os.environ.get("ECHO_TTS_LISTEN_ADDRESS", "0.0.0.0").strip() or "0.0.0.0",
            port=_env_int("ECHO_TTS_PORT", 5001, 1, 65_535),
            device=os.environ.get("ECHO_TTS_DEVICE", "cuda").strip() or "cuda",
            model_dtype=os.environ.get("ECHO_TTS_MODEL_DTYPE", "bfloat16").strip().lower(),
            fish_dtype=os.environ.get("ECHO_TTS_FISH_DTYPE", "float32").strip().lower(),
            sequence_length=sequence_length,
            max_text_utf8_bytes=_env_int("ECHO_TTS_MAX_TEXT_UTF8_BYTES", 740, 64, 760),
            num_steps=_env_int("ECHO_TTS_NUM_STEPS", 40, 1, 200),
            cfg_scale_text=_env_float("ECHO_TTS_CFG_SCALE_TEXT", 3.0, 0.0, 30.0),
            cfg_scale_speaker=_env_float("ECHO_TTS_CFG_SCALE_SPEAKER", 8.0, 0.0, 30.0),
            cfg_min_t=cfg_min_t,
            cfg_max_t=cfg_max_t,
            truncation_factor=_env_float("ECHO_TTS_TRUNCATION_FACTOR", 1.0, 0.05, 5.0),
            rescale_k=_env_float("ECHO_TTS_RESCALE_K", 1.0, 0.01, 100.0),
            rescale_sigma=_env_float("ECHO_TTS_RESCALE_SIGMA", 3.0, 0.01, 100.0),
            speaker_kv_scale=speaker_scale,
            speaker_kv_min_t=speaker_min_t,
            seed=_env_int("ECHO_TTS_SEED", 0, 0, 2_147_483_647),
        )


@dataclass(frozen=True)
class ResolvedVoice:
    path: Path
    response_id: str


class VoiceCatalog:
    """Resolve voice IDs inside one directory without accepting arbitrary paths."""

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
            choices = self.list_ids()
            if len(choices) == 1:
                effective = choices[0]
            elif not choices:
                raise VoiceError(f"no reference voices found in {self.root}")
            else:
                raise VoiceError("voice is required because more than one reference voice is installed")

        # A voice is an ID relative to voice_dir, never a caller-controlled path.
        if not SAFE_VOICE_ID.fullmatch(effective) or Path(effective).name != effective:
            raise VoiceError("voice must be a simple filename or filename stem")

        supplied = self.root / effective
        candidates: list[Path]
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

        # Strict long-form calls compare this header byte-for-byte with their
        # requested ID. Preserve a non-empty caller ID after resolving it.
        response_id = requested or effective
        return ResolvedVoice(path=resolved, response_id=response_id)


@dataclass(frozen=True)
class SynthesisResult:
    wav: bytes
    voice_id: str
    duration_seconds: float


def _torch_dtype(torch_module: Any, name: str) -> Any:
    aliases = {
        "bfloat16": torch_module.bfloat16,
        "bf16": torch_module.bfloat16,
        "float16": torch_module.float16,
        "fp16": torch_module.float16,
        "float32": torch_module.float32,
        "fp32": torch_module.float32,
    }
    try:
        return aliases[name]
    except KeyError as error:
        raise ConfigurationError(
            f"unsupported dtype {name!r}; use bfloat16, float16, or float32",
        ) from error


def _pcm16_wav(torch_module: Any, audio_tensor: Any, sample_rate: int = SAMPLE_RATE) -> tuple[bytes, float]:
    """Encode Echo's channel-first tensor as format-1 PCM without ffmpeg."""

    audio = audio_tensor.detach().to(device="cpu", dtype=torch_module.float32)
    if audio.ndim == 3 and audio.shape[0] == 1:
        audio = audio[0]
    if audio.ndim == 1:
        audio = audio.unsqueeze(0)
    if audio.ndim != 2 or audio.shape[0] < 1 or audio.shape[0] > 2:
        raise RuntimeError(f"unexpected Echo audio tensor shape: {tuple(audio.shape)}")
    if audio.shape[1] == 0:
        raise RuntimeError("Echo produced empty audio")

    audio = torch_module.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0).clamp(-1.0, 1.0)
    pcm = (audio.transpose(0, 1) * 32_767.0).round().to(torch_module.int16).contiguous()
    frames = pcm.numpy().tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(int(audio.shape[0]))
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(frames)
    duration = float(audio.shape[1]) / float(sample_rate)
    return output.getvalue(), duration


class EchoEngine:
    """Resident Echo model plus a single serialized inference lane."""

    def __init__(self, config: BridgeConfig):
        self.config = config
        self.voices = VoiceCatalog(config.voice_dir, config.default_voice)
        self._state_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._loading = False
        self._loaded = False
        self._load_error = ""
        self._loaded_at: float | None = None
        self._echo: Any = None
        self._torch: Any = None
        self._model: Any = None
        self._fish_ae: Any = None
        self._pca_state: Any = None
        self._sample_fn: Any = None
        self._speaker_cache: dict[Path, tuple[tuple[int, int], Any]] = {}

    def start_loading(self) -> None:
        with self._state_lock:
            if self._loading or self._loaded:
                return
            self._loading = True
        threading.Thread(target=self._load, name="echo-model-loader", daemon=True).start()

    def _load(self) -> None:
        try:
            repo = self.config.echo_repo.resolve(strict=True)
            if not (repo / "inference.py").is_file():
                raise ConfigurationError(f"Echo checkout has no inference.py: {repo}")
            sys.path.insert(0, str(repo))
            echo = importlib.import_module("inference")
            torch_module = importlib.import_module("torch")
            if self.config.device.startswith("cuda") and not torch_module.cuda.is_available():
                raise ConfigurationError("ECHO_TTS_DEVICE requests CUDA, but torch.cuda.is_available() is false")

            model_dtype = _torch_dtype(torch_module, self.config.model_dtype)
            fish_dtype = _torch_dtype(torch_module, self.config.fish_dtype)
            LOG.info("loading Echo-TTS model on %s", self.config.device)
            model = echo.load_model_from_hf(
                device=self.config.device,
                dtype=model_dtype,
                delete_blockwise_modules=True,
            )
            LOG.info("loading Fish S1-DAC autoencoder on %s", self.config.device)
            fish_ae = echo.load_fish_ae_from_hf(device=self.config.device, dtype=fish_dtype)
            pca_state = echo.load_pca_state_from_hf(device=self.config.device)
            sample_fn = partial(
                echo.sample_euler_cfg_independent_guidances,
                num_steps=self.config.num_steps,
                cfg_scale_text=self.config.cfg_scale_text,
                cfg_scale_speaker=self.config.cfg_scale_speaker,
                cfg_min_t=self.config.cfg_min_t,
                cfg_max_t=self.config.cfg_max_t,
                truncation_factor=self.config.truncation_factor,
                rescale_k=self.config.rescale_k,
                rescale_sigma=self.config.rescale_sigma,
                speaker_kv_scale=self.config.speaker_kv_scale,
                speaker_kv_max_layers=None,
                speaker_kv_min_t=self.config.speaker_kv_min_t,
                sequence_length=self.config.sequence_length,
            )
            with self._state_lock:
                self._echo = echo
                self._torch = torch_module
                self._model = model
                self._fish_ae = fish_ae
                self._pca_state = pca_state
                self._sample_fn = sample_fn
                self._loaded = True
                self._loading = False
                self._load_error = ""
                self._loaded_at = time.time()
            LOG.info("Echo-TTS is ready; voices=%s", self.voices.list_ids())
        except Exception as error:  # model/dependency failures belong in /health
            LOG.exception("Echo-TTS failed to load")
            with self._state_lock:
                self._loaded = False
                self._loading = False
                self._load_error = str(error)

    def health(self) -> dict[str, Any]:
        voice_ids = self.voices.list_ids()
        with self._state_lock:
            loaded = self._loaded
            loading = self._loading
            error = self._load_error
            loaded_at = self._loaded_at
        ready = loaded and bool(voice_ids)
        body: dict[str, Any] = {
            "ok": True,
            "ready": ready,
            "engine": ENGINE_ID,
            "maxSeconds": self.config.max_seconds,
            "voices": voice_ids,
            "modelReady": loaded,
            "loading": loading,
            "device": self.config.device,
            "contract": "subwave-remote-tts-v1",
        }
        if loaded_at is not None:
            body["loadedAt"] = loaded_at
        if error:
            body["error"] = error
        elif loaded and not voice_ids:
            body["error"] = f"no reference voices found in {self.config.voice_dir}"
        return body

    def _speaker_audio(self, path: Path) -> Any:
        stamp = path.stat()
        version = (stamp.st_mtime_ns, stamp.st_size)
        cached = self._speaker_cache.get(path)
        if cached and cached[0] == version:
            return cached[1]
        audio = self._echo.load_audio(str(path)).detach().cpu()
        self._speaker_cache[path] = (version, audio)
        return audio

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        text = text.strip()
        if not text:
            raise RequestError(HTTPStatus.BAD_REQUEST, "text must not be empty")
        if len(text.encode("utf-8")) > self.config.max_text_utf8_bytes:
            raise RequestError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                f"text exceeds Echo's {self.config.max_text_utf8_bytes}-byte acoustic window",
            )
        resolved_voice = self.voices.resolve(voice)

        with self._state_lock:
            loaded = self._loaded
            load_error = self._load_error
        if not loaded:
            detail = f": {load_error}" if load_error else ""
            raise ServiceNotReady(f"Echo-TTS is not ready{detail}")

        with self._inference_lock:
            LOG.info(
                "rendering %d UTF-8 bytes with voice=%s",
                len(text.encode("utf-8")),
                resolved_voice.response_id,
            )
            speaker_audio = self._speaker_audio(resolved_voice.path)
            try:
                audio, _normalized_text = self._echo.sample_pipeline(
                    model=self._model,
                    fish_ae=self._fish_ae,
                    pca_state=self._pca_state,
                    sample_fn=self._sample_fn,
                    text_prompt=text,
                    speaker_audio=speaker_audio,
                    rng_seed=self.config.seed,
                )
                wav, duration = _pcm16_wav(self._torch, audio, SAMPLE_RATE)
            except Exception:
                if self._torch.cuda.is_available():
                    self._torch.cuda.empty_cache()
                raise
            LOG.info("rendered %.2fs for voice=%s", duration, resolved_voice.response_id)
            return SynthesisResult(wav=wav, voice_id=resolved_voice.response_id, duration_seconds=duration)


class EchoHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], engine: Any):
        self.engine = engine
        super().__init__(address, EchoRequestHandler)


class EchoRequestHandler(BaseHTTPRequestHandler):
    server: EchoHttpServer
    protocol_version = "HTTP/1.1"
    server_version = "subwave-echo-tts/1"
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
            LOG.exception("Echo-TTS synthesis failed")
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Echo-TTS synthesis failed: {error}")
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


def build_server(listen_address: str, port: int, engine: Any) -> EchoHttpServer:
    return EchoHttpServer((listen_address, port), engine)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Echo-TTS bridge for SUB/WAVE")
    parser.add_argument("--listen-address", help="override ECHO_TTS_LISTEN_ADDRESS")
    parser.add_argument("--port", type=int, help="override ECHO_TTS_PORT")
    parser.add_argument("--echo-repo", help="override ECHO_TTS_REPO")
    parser.add_argument("--voice-dir", help="override ECHO_TTS_VOICE_DIR")
    parser.add_argument("--default-voice", help="override ECHO_TTS_DEFAULT_VOICE")
    parser.add_argument("--device", help="override ECHO_TTS_DEVICE")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    overrides = {
        "ECHO_TTS_LISTEN_ADDRESS": args.listen_address,
        "ECHO_TTS_PORT": str(args.port) if args.port is not None else None,
        "ECHO_TTS_REPO": args.echo_repo,
        "ECHO_TTS_VOICE_DIR": args.voice_dir,
        "ECHO_TTS_DEFAULT_VOICE": args.default_voice,
        "ECHO_TTS_DEVICE": args.device,
    }
    for key, value in overrides.items():
        if value is not None:
            os.environ[key] = value

    logging.basicConfig(
        level=os.environ.get("ECHO_TTS_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )
    try:
        config = BridgeConfig.from_env()
        config.voice_dir.mkdir(parents=True, exist_ok=True)
        engine = EchoEngine(config)
        server = build_server(config.listen_address, config.port, engine)
    except Exception as error:
        LOG.error("cannot start Echo-TTS bridge: %s", error)
        return 2

    engine.start_loading()
    LOG.info("HTTP bridge listening on http://%s:%d", config.listen_address, config.port)
    LOG.info("health remains ready=false until the model and at least one reference voice are loaded")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        LOG.info("shutdown requested")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
