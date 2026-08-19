from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lvt_host.runtime_stack import _cuda_available, ensure_cuda_dlls


def main() -> None:
    ensure_cuda_dlls()
    from faster_whisper import WhisperModel

    device = "cuda" if _cuda_available() else "cpu"
    compute = "int8_float16" if device == "cuda" else "int8"
    print(f"downloading faster-whisper large-v3-turbo on {device}/{compute}")
    WhisperModel("large-v3-turbo", device=device, compute_type=compute)
    print("asr model ready")


if __name__ == "__main__":
    main()
