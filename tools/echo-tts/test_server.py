"""Dependency-free contract tests for the Echo-TTS bridge.

These tests deliberately use a fake inference engine. They validate the HTTP
surface and path-safety rules without downloading Echo or importing torch.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("subwave_echo_tts_server", MODULE_PATH)
assert SPEC and SPEC.loader
BRIDGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE
SPEC.loader.exec_module(BRIDGE)

SUPERVISOR_SPEC = importlib.util.spec_from_file_location(
    "subwave_windows_ai_supervisor",
    Path(__file__).with_name("supervisor.py"),
)
assert SUPERVISOR_SPEC and SUPERVISOR_SPEC.loader
SUPERVISOR = importlib.util.module_from_spec(SUPERVISOR_SPEC)
sys.modules[SUPERVISOR_SPEC.name] = SUPERVISOR
SUPERVISOR_SPEC.loader.exec_module(SUPERVISOR)


def fixture_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44_100)
        wav.writeframes(b"\x00\x00" * 100)
    return output.getvalue()


class FakeEngine:
    def health(self):
        return {
            "ok": True,
            "ready": True,
            "engine": "echotts",
            "maxSeconds": 30,
            "voices": ["narrator.wav"],
        }

    def synthesize(self, text: str, voice: str):
        if not text.strip():
            raise BRIDGE.RequestError(400, "text must not be empty")
        if voice == "missing":
            raise BRIDGE.VoiceError('reference voice "missing" was not found')
        return BRIDGE.SynthesisResult(
            wav=fixture_wav(),
            voice_id=voice or "narrator.wav",
            duration_seconds=0.01,
        )


class RunningServer:
    def __enter__(self):
        self.server = BRIDGE.build_server("127.0.0.1", 0, FakeEngine())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class VoiceCatalogTests(unittest.TestCase):
    def test_resolves_filename_and_unique_stem(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "narrator.wav").write_bytes(fixture_wav())
            catalog = BRIDGE.VoiceCatalog(root)
            self.assertEqual(catalog.resolve("narrator.wav").response_id, "narrator.wav")
            self.assertEqual(catalog.resolve("narrator").response_id, "narrator")
            self.assertEqual(catalog.resolve("").response_id, "narrator.wav")

    def test_rejects_traversal_and_ambiguous_stems(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "voice.wav").write_bytes(fixture_wav())
            (root / "voice.flac").write_bytes(b"fixture")
            catalog = BRIDGE.VoiceCatalog(root)
            with self.assertRaises(BRIDGE.VoiceError):
                catalog.resolve("../outside.wav")
            with self.assertRaises(BRIDGE.VoiceError):
                catalog.resolve("voice")


class SupervisorSelectionTests(unittest.TestCase):
    def test_auto_selects_a_sole_gguf(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            model = root / "radio.gguf"
            model.write_bytes(b"GGUF")
            selected = SUPERVISOR._pick_model({"model": "", "modelDirectory": str(root)})
            self.assertEqual(selected, model.resolve())

    def test_requires_explicit_model_when_directory_has_multiple_ggufs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "one.gguf").write_bytes(b"GGUF")
            (root / "two.gguf").write_bytes(b"GGUF")
            with self.assertRaises(SUPERVISOR.ConfigurationError):
                SUPERVISOR._pick_model({"model": "", "modelDirectory": str(root)})

    def test_auto_selects_a_sole_voice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            voice = root / "narrator.wav"
            voice.write_bytes(fixture_wav())
            selected_dir, selected_id = SUPERVISOR._pick_voice(
                {"voiceDirectory": str(root), "defaultVoice": ""},
            )
            self.assertEqual(selected_dir, root.resolve())
            self.assertEqual(selected_id, voice.name)

    def test_selects_a_shared_ffmpeg_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "ffmpeg.exe").write_bytes(b"fixture")
            for name in ("avcodec-62.dll", "avformat-62.dll", "avutil-60.dll", "swresample-6.dll"):
                (root / name).write_bytes(b"fixture")
            selected = SUPERVISOR._pick_ffmpeg({"ffmpegDirectory": str(root)})
            self.assertEqual(selected, root.resolve())


class HttpContractTests(unittest.TestCase):
    def test_health_and_pcm_speak_contract(self):
        with RunningServer() as running:
            with urllib.request.urlopen(f"{running.base}/health", timeout=2) as response:
                health = json.load(response)
                self.assertEqual(response.headers["Connection"], "close")
            self.assertTrue(health["ok"])
            self.assertTrue(health["ready"])
            self.assertEqual(health["engine"], "echotts")

            request = urllib.request.Request(
                f"{running.base}/speak",
                data=json.dumps({"text": "Hello from the booth.", "voice": "narrator.wav"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                audio = response.read()
                self.assertEqual(response.headers["Content-Type"], "audio/wav")
                self.assertEqual(response.headers["X-TTS-Voice-Used"], "narrator.wav")
                self.assertEqual(response.headers["X-TTS-Fell-Back"], "false")
                self.assertEqual(response.headers["Connection"], "close")
            self.assertEqual(audio[:4], b"RIFF")
            self.assertEqual(audio[8:12], b"WAVE")
            with wave.open(io.BytesIO(audio), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 44_100)

    def test_bad_input_returns_json_error(self):
        with RunningServer() as running:
            request = urllib.request.Request(
                f"{running.base}/speak",
                data=b"not-json",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request, timeout=2)
            try:
                self.assertEqual(raised.exception.code, 400)
                body = json.loads(raised.exception.read())
                self.assertFalse(body["ok"])
            finally:
                raised.exception.close()

    def test_missing_voice_is_explicit_and_never_falls_back(self):
        with RunningServer() as running:
            request = urllib.request.Request(
                f"{running.base}/speak",
                data=json.dumps({"text": "Hello", "voice": "missing"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request, timeout=2)
            try:
                self.assertEqual(raised.exception.code, 422)
            finally:
                raised.exception.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
