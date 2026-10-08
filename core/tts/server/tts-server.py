#!/usr/bin/env python3
"""
AImy TTS server — local Chatterbox voice synthesis over HTTP.

Endpoints:
  GET  /health       -> {"model_loaded": bool, "gpu": str | null}
  GET  /voices       -> {"voices": [{"id", "name", "is_default"}]}
  POST /speak        {"text", "voice_id"} -> {"audio_base64": wav} | {"error": msg}
  POST /voices/add   {"name", "audio_base64"} -> {"voice": {...}} | {"error": msg}

Voice references live in ~/.aimy/voices/*.wav (id = filename stem).
The model loads lazily on first /speak — /health answers honestly before
torch/chatterbox are even installed.

Requires: pip install chatterbox-tts torch
"""

import base64
import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PORT = int(os.environ.get("AIMY_TTS_PORT", "8001"))
VOICES_DIR = Path.home() / ".aimy" / "voices"
DEFAULT_VOICE_ID = "default"

_model = None
_model_lock = threading.Lock()
_voices_cache: dict | None = None


def detect_device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def gpu_name() -> str | None:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "Apple MPS"
    except ImportError:
        pass
    return None


def load_model():
    """Lazy-load Chatterbox. Raises RuntimeError with an honest message."""
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from chatterbox.tts import ChatterboxTTS
        except ImportError as e:
            raise RuntimeError(
                "chatterbox-tts is not installed. Install it with: pip install chatterbox-tts torch"
            ) from e
        device = detect_device()
        print(f"[tts] loading Chatterbox on {device}...", flush=True)
        try:
            _model = ChatterboxTTS.from_pretrained(device=device)
        except Exception as e:
            raise RuntimeError(f"Chatterbox failed to load on {device}: {e}") from e
        print("[tts] model loaded.", flush=True)
        return _model


def list_voices() -> list[dict]:
    """Built-in default + every ~/.aimy/voices/*.wav."""
    voices = [{"id": DEFAULT_VOICE_ID, "name": "Default (built-in neutral)", "is_default": True}]
    if VOICES_DIR.is_dir():
        for wav in sorted(VOICES_DIR.glob("*.wav")):
            vid = wav.stem
            if vid == DEFAULT_VOICE_ID:
                continue
            voices.append({"id": vid, "name": vid.replace("_", " ").replace("-", " "), "is_default": False})
    return voices


def resolve_voice(voice_id: str) -> Path | None:
    """None = built-in default. Returns None for unknown ids too (caller checks)."""
    if voice_id in (None, "", DEFAULT_VOICE_ID):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_-]+", voice_id):
        return "invalid"  # type: ignore[return-value]
    p = VOICES_DIR / f"{voice_id}.wav"
    return p if p.is_file() else "unknown"  # type: ignore[return-value]


def synthesize(text: str, voice_id: str) -> bytes:
    """Text -> 16-bit PCM mono WAV bytes. Raises RuntimeError on failure."""
    if not text or not text.strip():
        raise RuntimeError("text must not be empty")
    if len(text) > 2000:
        raise RuntimeError("text too long for one call (max 2000 chars); chunk it first")

    voice_path = resolve_voice(voice_id or DEFAULT_VOICE_ID)
    if voice_path == "invalid":
        raise RuntimeError(f"invalid voice id {voice_id!r}")
    if voice_path == "unknown":
        raise RuntimeError(f"unknown voice {voice_id!r}")

    model = load_model()
    try:
        with _model_lock:
            if voice_path is None:
                wav = model.generate(text)
            else:
                wav = model.generate(text, audio_prompt_path=str(voice_path))
    except Exception as e:
        raise RuntimeError(f"synthesis failed: {e}") from e

    # torch float32 tensor -> 16-bit PCM WAV via stdlib wave
    import torch

    pcm = (wav.squeeze(0).clamp(-1.0, 1.0) * 32767).short().cpu().numpy()
    sr = int(getattr(model, "sr", 24000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "AImyTTS/1.0"

    def _json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 10 * 1024 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def log_message(self, fmt, *args):  # quieter than BaseHTTPRequestHandler default
        print(f"[tts] {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json({"model_loaded": _model is not None, "gpu": gpu_name()})
        elif path == "/voices":
            self._json({"voices": list_voices()})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/speak":
            body = self._read_json()
            try:
                wav = synthesize(str(body.get("text", "")), str(body.get("voice_id", DEFAULT_VOICE_ID)))
            except RuntimeError as e:
                self._json({"error": str(e)}, 500)
                return
            self._json({"audio_base64": base64.b64encode(wav).decode()})
        elif path == "/voices/add":
            body = self._read_json()
            name = str(body.get("name", "")).strip()
            audio_b64 = str(body.get("audio_base64", ""))
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,39}", name):
                self._json({"error": "name must be 1-40 chars: letters, digits, space, _ -"}, 400)
                return
            vid = re.sub(r"\s+", "_", name.strip().lower())
            if not audio_b64:
                self._json({"error": "audio_base64 required"}, 400)
                return
            try:
                raw = base64.b64decode(audio_b64, validate=True)
            except Exception:
                self._json({"error": "audio_base64 is not valid base64"}, 400)
                return
            if raw[0:4] != b"RIFF" or len(raw) < 1000:
                self._json({"error": "reference must be a WAV file (>= 1KB)"}, 400)
                return
            VOICES_DIR.mkdir(parents=True, exist_ok=True)
            (VOICES_DIR / f"{vid}.wav").write_bytes(raw)
            self._json({"voice": {"id": vid, "name": name, "is_default": False}})
        else:
            self._json({"error": "not found"}, 404)


def main() -> None:
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[tts] AImy TTS server on http://127.0.0.1:{PORT} (voices: {VOICES_DIR})", flush=True)
    print("[tts] model loads lazily on first /speak", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[tts] stopped.", flush=True)


if __name__ == "__main__":
    main()
