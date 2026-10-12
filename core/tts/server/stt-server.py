#!/usr/bin/env python3
"""
AImy STT server — local speech-to-text over HTTP.
Mirrors tts-server.py: listens on 127.0.0.1:8002, accepts WAV audio, returns text.

Endpoints:
  GET  /health       -> {"status": "ok", "engine": "..."}
  POST /transcribe  -> {"text": "...", "latency_ms": ...}
       Body: {"audio_base64": "...", "sample_rate": 16000}
  POST /test         -> {"latency_ms": ..., "model_size_mb": ...}
"""
import base64
import io
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

ENGINE = os.environ.get("AIMY_STT_ENGINE", "parakeet-mlx")
MODEL_ID = os.environ.get("AIMY_STT_MODEL", "mlx-community/parakeet-tdt-0.6b-v2")
PORT = int(os.environ.get("AIMY_STT_PORT", "8002"))

_model = None
_engine_name = "unknown"


def load_model():
    global _model, _engine_name
    print(f"[stt] Python: {sys.version.split()[0]}", flush=True)
    # Use explicit cache dir (from env, or HF default).
    cache_dir = os.environ.get("HF_HUB_CACHE") or os.environ.get("PARAKEET_CACHE_DIR")
    if cache_dir:
        print(f"[stt] Using cache dir: {cache_dir}", flush=True)
    if ENGINE.startswith("parakeet-mlx"):
        try:
            from parakeet_mlx import from_pretrained
            print(f"[stt] parakeet_mlx imported OK", flush=True)
        except ImportError as e:
            print(f"[stt] FATAL: cannot import parakeet_mlx: {e}", flush=True)
            print(f"[stt] Hint: pip install parakeet-mlx soundfile numpy huggingface_hub", flush=True)
            raise
        print(f"[stt] Loading: {MODEL_ID} (downloads ~600MB on first run)", flush=True)
        try:
            kwargs = {"cache_dir": cache_dir} if cache_dir else {}
            _model = from_pretrained(MODEL_ID, **kwargs)
        except Exception as e:
            print(f"[stt] FATAL: model load failed: {e}", flush=True)
            traceback.print_exc()
            raise
        _engine_name = f"Parakeet MLX ({MODEL_ID.split('/')[-1]})"
    elif ENGINE.startswith("mlx-whisper"):
        import mlx_whisper
        print(f"[stt] MLX Whisper (lazy): {MODEL_ID}", flush=True)
        _model = mlx_whisper
        _engine_name = f"MLX Whisper ({MODEL_ID.split('/')[-1]})"
    else:
        raise RuntimeError(f"Unsupported STT engine: {ENGINE}")
    print(f"[stt] Ready: {_engine_name}", flush=True)


def estimate_model_size_mb():
    """Estimate model size from HF cache directory."""
    try:
        cache = os.environ.get("HF_HUB_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
        model_dir = os.path.join(cache, f"models--{MODEL_ID.replace('/', '--')}")
        if not os.path.exists(model_dir):
            return 0.0
        total = 0
        for root, _, files in os.walk(model_dir):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except:
                    pass
        return round(total / 1024 / 1024, 1)
    except:
        return 0.0


def transcribe_wav(wav_bytes, sample_rate=16000):
    import numpy as np
    import soundfile as sf
    start = time.time()
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        ratio = 16000 / sr
        new_len = int(len(audio) * ratio)
        audio = np.interp(
            np.linspace(0, len(audio), new_len),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)
    audio = audio.astype(np.float32)
    if ENGINE.startswith("parakeet-mlx"):
        import tempfile
        import os
        # parakeet_mlx.transcribe() expects a file path, not an ndarray.
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio, 16000)
            tmp = f.name
        try:
            result = _model.transcribe(tmp)
            text = result.text if hasattr(result, "text") else str(result)
        finally:
            try: os.unlink(tmp)
            except: pass
    elif ENGINE.startswith("mlx-whisper"):
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio, 16000)
            tmp = f.name
        try:
            result = _model.transcribe(tmp, path_or_hf_repo=MODEL_ID)
            text = result.get("text", "").strip()
        finally:
            os.unlink(tmp)
    else:
        raise RuntimeError(f"Unsupported: {ENGINE}")
    return text, (time.time() - start) * 1000


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "engine": _engine_name})
        else:
            self._json({"error": "not found"}, 404)
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        try:
            if self.path == "/transcribe":
                wav_bytes = base64.b64decode(body.get("audio_base64", ""))
                sr = int(body.get("sample_rate", 16000))
                print(f"[stt] transcribe: {len(wav_bytes)} bytes @ {sr}Hz", flush=True)
                text, latency_ms = transcribe_wav(wav_bytes, sr)
                preview = text[:80] + ("..." if len(text) > 80 else "")
                print(f"[stt] transcribe done: {latency_ms:.0f}ms -> \"{preview}\"", flush=True)
                self._json({"text": text, "latency_ms": latency_ms})
            elif self.path == "/test":
                print(f"[stt] test: synthetic latency check", flush=True)
                import numpy as np
                import soundfile as sf
                silent = np.zeros(16000, dtype=np.float32)
                buf = io.BytesIO()
                sf.write(buf, silent, 16000, format="WAV")
                text, latency_ms = transcribe_wav(buf.getvalue(), 16000)
                print(f"[stt] test done: {latency_ms:.0f}ms", flush=True)
                # Estimate model size from HF cache.
                model_size_mb = estimate_model_size_mb()
                self._json({"latency_ms": latency_ms, "model_size_mb": model_size_mb, "text": text})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            self._json({"error": str(e)}, 500)


if __name__ == "__main__":
    print(f"[stt] Starting (engine={ENGINE}, model={MODEL_ID})", flush=True)
    try:
        load_model()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[stt] Listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
