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


def _sniff_format(raw: bytes) -> tuple[str, str]:
    """(temp-file suffix, human label) from magic bytes."""
    if raw[:4] == b"RIFF":
        return ".wav", "WAV"
    if raw[:3] == b"ID3" or raw[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return ".mp3", "MP3"
    if raw[:4] == b"fLaC":
        return ".flac", "FLAC"
    if raw[:4] == b"OggS":
        return ".ogg", "OGG"
    if len(raw) >= 8 and raw[4:8] == b"ftyp":
        return ".m4a", "M4A"
    return ".audio", "unknown-format"


def _slugify_voice_id(name: str) -> str:
    """Voice id from a display name: the server's alphabet is
    [a-z0-9_-]; everything else folds to underscores, so a name
    the user (or a filename) supplies can never be rejected for
    its punctuation — "Mom's Voice (final!)" becomes
    mom_s_voice_final instead of a 400."""
    return re.sub(r"[^a-z0-9_-]+", "_", name.strip().lower()).strip("_")[:40].strip("_")


def _reference_to_wav(raw: bytes) -> tuple[bytes | None, str]:
    """Normalise a voice reference clip to WAV bytes.

    Returns (wav_bytes, format_label) or (None, format_label).
    WAV passes through untouched (the long-standing behavior).
    Anything else is decoded by TRYING EACH DECODER THIS HOST
    MIGHT HAVE — torchaudio (Chatterbox's own dependency), then
    soundfile (bundled with librosa, Chatterbox's other
    dependency; its libsndfile decodes MP3/FLAC/OGG), then an
    ffmpeg binary (the only one of the three that reads M4A).
    A decoder that is missing or fails is logged and the next
    is tried: one unavailable library must never become a
    refused voice. ~/.aimy/voices stays WAV on disk either way.
    """
    suffix, label = _sniff_format(raw)
    if len(raw) < 1000:
        return None, label
    if raw[0:4] == b"RIFF":
        return raw, label
    tmp_path: str | None = None
    try:
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(raw)
            tmp_path = f.name

        try:
            import torchaudio

            waveform, sample_rate = torchaudio.load(tmp_path)
            buf = io.BytesIO()
            torchaudio.save(buf, waveform, sample_rate, format="wav")
            data = buf.getvalue()
            if len(data) >= 1000:
                return data, label
            raise RuntimeError("torchaudio produced a suspiciously small WAV")
        except Exception as e:
            print(f"[tts] reference decode via torchaudio failed ({label}): {e}", flush=True)

        try:
            import soundfile as sf

            frames, sample_rate = sf.read(tmp_path, always_2d=True)
            buf = io.BytesIO()
            sf.write(buf, frames, sample_rate, format="WAV")
            data = buf.getvalue()
            if len(data) >= 1000:
                return data, label
            raise RuntimeError("soundfile produced a suspiciously small WAV")
        except Exception as e:
            print(f"[tts] reference decode via soundfile failed ({label}): {e}", flush=True)

        try:
            import subprocess

            out = subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", tmp_path, "-f", "wav", "pipe:1"],
                capture_output=True,
                timeout=60,
            )
            if out.returncode == 0 and len(out.stdout) >= 1000:
                return out.stdout, label
            raise RuntimeError(
                f"ffmpeg exited {out.returncode}: {out.stderr.decode(errors='replace')[:200]}"
            )
        except Exception as e:
            print(f"[tts] reference decode via ffmpeg failed ({label}): {e}", flush=True)

        return None, label
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


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


def _disable_broken_watermarker():
    """Stub out perth watermarking when it can't import.

    perth 1.0.0 imports pkg_resources, which was removed from setuptools on
    Python 3.12+. Its __init__ swallows the ImportError and leaves
    PerthImplicitWatermarker = None, which makes ChatterboxTTS.__init__ raise
    "TypeError: 'NoneType' object is not callable". When the real watermarker
    is unavailable we replace it with a no-op that returns the audio
    unchanged. chatterbox does `import perth` (module attribute access), so
    patching the module object works.

    Note: model-level AI-detection watermarking stays enabled when it works —
    that's an honesty benefit (marks output as synthetic), not surveillance.
    Revisit if watermarking ever moves to per-user or per-developer
    attribution.
    """
    try:
        import perth
    except ImportError:
        return
    if getattr(perth, "PerthImplicitWatermarker", None) is not None:
        return

    class _NoWatermark:
        def apply_watermark(self, wav, sample_rate=None, **kwargs):
            return wav

    perth.PerthImplicitWatermarker = _NoWatermark
    print("[tts] perth watermarker unavailable — watermarking disabled", flush=True)


def load_model():
    """Lazy-load Chatterbox. Raises RuntimeError with an honest message."""
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
        except ImportError as e:
            raise RuntimeError(
                "chatterbox-tts with turbo support is not installed. Install from source: pip install git+https://github.com/resemble-ai/chatterbox.git"
            ) from e
        _disable_broken_watermarker()
        device = detect_device()
        print(f"[tts] loading Chatterbox Nano (110M) on {device}...", flush=True)
        try:
            _model = ChatterboxTurboTTS.from_pretrained(device=device)
        except Exception as e:
            raise RuntimeError(f"Chatterbox Turbo failed to load on {device}: {e}") from e
        print("[tts] model loaded.", flush=True)
        return _model


def list_voices() -> list[dict]:
    """Built-in default + every ~/.aimy/voices/*.wav."""
    default_id = get_default_voice_id()
    voices = [{"id": DEFAULT_VOICE_ID, "name": "Default (built-in neutral)", "is_default": default_id == DEFAULT_VOICE_ID}]
    if VOICES_DIR.is_dir():
        for wav in sorted(VOICES_DIR.glob("*.wav")):
            vid = wav.stem
            if vid == DEFAULT_VOICE_ID:
                continue
            voices.append({"id": vid, "name": vid.replace("_", " ").replace("-", " "), "is_default": vid == default_id})
    return voices


def get_default_voice_id() -> str:
    """Read the default voice ID from disk, or the built-in default."""
    try:
        p = VOICES_DIR / "default.txt"
        if p.is_file():
            vid = p.read_text().strip()
            if vid:
                return vid
    except Exception:
        pass
    return DEFAULT_VOICE_ID


def set_default_voice_id(voice_id: str) -> None:
    """Persist the default voice ID to disk."""
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    (VOICES_DIR / "default.txt").write_text(voice_id)


def resolve_voice(voice_id: str) -> Path | None:
    """None = built-in default. Returns None for unknown ids too (caller checks)."""
    if voice_id in (None, "", DEFAULT_VOICE_ID):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_-]+", voice_id):
        return "invalid"  # type: ignore[return-value]
    p = VOICES_DIR / f"{voice_id}.wav"
    return p if p.is_file() else "unknown"  # type: ignore[return-value]


def strip_markdown(text: str) -> str:
    """Remove markdown formatting for natural speech. Keeps the words, drops the syntax."""
    # Code blocks -> "code" placeholder (don't read code aloud verbatim).
    text = re.sub(r"```[\s\S]*?```", " [code block] ", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    # Images -> alt text only.
    text = re.sub(r"!\[([^\]]*)\]\([^\)]*\)", r"\1", text)
    # Links -> link text only.
    text = re.sub(r"\[([^\]]*)\]\([^\)]*\)", r"\1", text)
    # Headers -> text without #.
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Bold/italic/strikethrough.
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    # Lists -> comma-separated items.
    text = re.sub(r"^[\s]*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[\s]*\d+\.\s+", "", text, flags=re.MULTILINE)
    # Blockquotes.
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    # Horizontal rules.
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    # Collapse whitespace.
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def synthesize(text: str, voice_id: str) -> bytes:
    """Text -> 16-bit PCM mono WAV bytes. Raises RuntimeError on failure."""
    # Strip markdown so the voice doesn't read syntax aloud.
    text = strip_markdown(text)
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
        import traceback
        traceback.print_exc()
        raise RuntimeError(f"synthesis failed: {e}") from e

    # torch tensor -> 16-bit PCM WAV via stdlib wave
    # MPS doesn't support float64: move to CPU as float32 first.
    import torch

    wav = wav.to(dtype=torch.float32).cpu()
    pcm = (wav.squeeze(0).clamp(-1.0, 1.0) * 32767).short().numpy()
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
            # Model size: Nano 110M ~ 440MB, standard 500M ~ 2GB.
            model_size = 440 if _model is not None and "nano" in str(type(_model)).lower() else 2000
            self._json({"model_loaded": _model is not None, "gpu": gpu_name(), "model_size_mb": model_size})
        elif path == "/voices":
            self._json({"voices": list_voices()})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        # POST /voices/{id}/delete — delete a custom voice.
        m = re.fullmatch(r"/voices/([A-Za-z0-9_-]+)/delete", path)
        if m:
            vid = m.group(1)
            if vid == DEFAULT_VOICE_ID:
                self._json({"error": "cannot delete the built-in default voice"}, 400)
                return
            p = VOICES_DIR / f"{vid}.wav"
            if p.is_file():
                p.unlink()
                if get_default_voice_id() == vid:
                    set_default_voice_id(DEFAULT_VOICE_ID)
                self._json({"deleted": vid})
            else:
                self._json({"error": "voice not found"}, 404)
            return
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
            name = str(body.get("name", "")).strip()[:80]
            audio_b64 = str(body.get("audio_base64", ""))
            vid = _slugify_voice_id(name)
            if vid == "":
                self._json({"error": "the voice name needs at least one letter or digit"}, 400)
                return
            if not audio_b64:
                self._json({"error": "audio_base64 required"}, 400)
                return
            try:
                raw = base64.b64decode(audio_b64, validate=True)
            except Exception:
                self._json({"error": "audio_base64 is not valid base64"}, 400)
                return
            wav_raw, fmt_label = _reference_to_wav(raw)
            if wav_raw is None:
                self._json(
                    {
                        "error": f"could not decode the {fmt_label} reference on this machine — torchaudio, soundfile and ffmpeg all failed or are unavailable (a WAV export always works)"
                    },
                    400,
                )
                return
            VOICES_DIR.mkdir(parents=True, exist_ok=True)
            (VOICES_DIR / f"{vid}.wav").write_bytes(wav_raw)
            self._json({"voice": {"id": vid, "name": name, "is_default": False}})
        elif re.fullmatch(r"/voices/[A-Za-z0-9_-]+/default", path):
            vid = path.split("/")[2]
            # Validate the voice exists.
            if vid != DEFAULT_VOICE_ID:
                p = VOICES_DIR / f"{vid}.wav"
                if not p.is_file():
                    self._json({"error": "voice not found"}, 404)
                    return
            set_default_voice_id(vid)
            self._json({"default": vid})
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
