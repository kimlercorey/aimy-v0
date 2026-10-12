#!/usr/bin/env python3
"""Download an STT model from HuggingFace with progress reporting.

Usage: download-stt-model.py <model-id>
Reports progress as JSON lines to stdout:
  {"downloaded_mb": 123.4, "total_mb": 600.0, "percent": 20.6}
On completion:
  {"done": true, "path": "/path/to/model"}
On error:
  {"error": "message"}
"""
import json
import sys
import time

MODEL_ID = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/parakeet-tdt-0.6b-v3"

def report(**kwargs):
    print(json.dumps(kwargs), flush=True)

try:
    from huggingface_hub import snapshot_download
    from huggingface_hub.utils import tqdm as hf_tqdm
    import signal
    
    # Timeout for the initial connection (fail fast if HF Hub is unreachable)
    def timeout_handler(signum, frame):
        raise TimeoutError("HuggingFace Hub connection timed out (30s)")
    signal.signal(signal.SIGALRM, timeout_handler)
    
    total_downloaded = 0
    last_report = 0
    # Track per-file to avoid double-counting on retries
    file_progress = {}
    
    class ProgressTqdm(hf_tqdm):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            # Use desc as file identifier
            self._file_id = getattr(self, 'desc', str(id(self)))
            file_progress[self._file_id] = 0
        
        def update(self, n=1):
            super().update(n)
            global total_downloaded, last_report
            # Update this file's progress
            old = file_progress.get(self._file_id, 0)
            file_progress[self._file_id] = self.n
            delta = self.n - old
            total_downloaded += delta
            now = time.time()
            if now - last_report > 0.5:
                last_report = now
                downloaded_mb = total_downloaded / 1024 / 1024
                # Estimate total as 600MB for parakeet (we don't know upfront)
                # Report downloaded MB; percent is approximate
                report(downloaded_mb=round(downloaded_mb, 1),
                       total_mb=600,
                       percent=round(min(downloaded_mb / 600 * 100, 100), 1))
    
    report(downloaded_mb=0, total_mb=0, percent=0,
           message=f"Downloading {MODEL_ID}...")
    
    # Set 30s alarm for the download start
    signal.alarm(30)
    path = snapshot_download(
        MODEL_ID,
        tqdm_class=ProgressTqdm,
        max_workers=4,
    )
    signal.alarm(0)  # cancel alarm
    report(done=True, path=path)
    
except Exception as e:
    import traceback
    report(error=str(e), traceback=traceback.format_exc())
    sys.exit(1)
