"""Dependency-free contract tests for the Chatterbox Turbo HTTP bridge."""

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
SPEC = importlib.util.spec_from_file_location("subwave_chatterbox_turbo_server", MODULE_PATH)
assert SPEC and SPEC.loader
BRIDGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE
SPEC.loader.exec_module(BRIDGE)


def fixture_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        wav.writeframes(b"\x00\x00" * 100)
    return output.getvalue()


class FakeEngine:
    def health(self):
        return {
            "ok": True,
            "ready": True,
            "engine": "chatterbox-turbo",
            "maxSeconds": 120,
            "voices": ["narrator.wav"],
            "features": ["voice-cloning", "paralinguistic-tags", "longform-chunking"],
        }

    def synthesize(self, text: str, voice: str):
        if not text.strip():
            raise BRIDGE.RequestError(400, "text must not be empty")
        if voice == "missing":
            raise BRIDGE.VoiceError('reference voice "missing" was not found')
        return BRIDGE.SynthesisResult(
            wav=fixture_wav(),
            voice_id=voice or "builtin",
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
    def test_builtin_filename_and_unique_stem(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "narrator.wav").write_bytes(fixture_wav())
            catalog = BRIDGE.VoiceCatalog(root)
            self.assertEqual(catalog.resolve("").response_id, "builtin")
            self.assertEqual(catalog.resolve("narrator.wav").response_id, "narrator.wav")
            self.assertEqual(catalog.resolve("narrator").response_id, "narrator")

    def test_rejects_traversal_missing_and_ambiguous_stems(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "voice.wav").write_bytes(fixture_wav())
            (root / "voice.flac").write_bytes(b"fixture")
            catalog = BRIDGE.VoiceCatalog(root)
            for invalid in ("../outside.wav", "missing"):
                with self.subTest(invalid=invalid), self.assertRaises(BRIDGE.VoiceError):
                    catalog.resolve(invalid)
            with self.assertRaises(BRIDGE.VoiceError):
                catalog.resolve("voice")


class HttpContractTests(unittest.TestCase):
    def test_health_and_pcm_speak_contract(self):
        with RunningServer() as running:
            with urllib.request.urlopen(f"{running.base}/health", timeout=2) as response:
                health = json.load(response)
                self.assertEqual(response.headers["Connection"], "close")
            self.assertEqual(health["engine"], "chatterbox-turbo")
            self.assertIn("longform-chunking", health["features"])

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
            self.assertEqual(audio[:4], b"RIFF")
            self.assertEqual(audio[8:12], b"WAVE")

    def test_bad_input_and_missing_voice_are_explicit(self):
        with RunningServer() as running:
            bad_json = urllib.request.Request(
                f"{running.base}/speak",
                data=b"not-json",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(bad_json, timeout=2)
            try:
                self.assertEqual(raised.exception.code, 400)
            finally:
                raised.exception.close()

            missing = urllib.request.Request(
                f"{running.base}/speak",
                data=json.dumps({"text": "Hello", "voice": "missing"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(missing, timeout=2)
            try:
                self.assertEqual(raised.exception.code, 422)
            finally:
                raised.exception.close()


class SourceContractTests(unittest.TestCase):
    def test_default_worker_is_the_existing_subwave_worker(self):
        expected = BRIDGE.REPO_ROOT / "controller" / "scripts" / "chatterbox_worker.py"
        self.assertEqual(BRIDGE.DEFAULT_WORKER, expected)
        self.assertTrue(expected.is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
