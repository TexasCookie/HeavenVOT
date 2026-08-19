#!/usr/bin/env python3
"""Fast downloads via aria2c (multi-connection). Falls back to curl.

Set HF_TOKEN in the environment. Do not commit tokens.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("AV_MODELS_ROOT", str(ROOT / "models")))
LLM = MODELS / "llm"
PIPER = MODELS / "piper"
WHISPER = MODELS / "whisper"
HUB = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")

# Many connections — beats single-stream VPN throttle (aria2 caps -x at 16)
ARIA_X = min(16, max(1, int(os.environ.get("AV_ARIA_X", "16"))))
ARIA_S = min(16, max(1, int(os.environ.get("AV_ARIA_S", "16"))))
ARIA_K = os.environ.get("AV_ARIA_SPLIT", "1M")


def _token() -> str | None:
    t = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    return t or None


def _find_aria2() -> str | None:
    env = os.environ.get("ARIA2C")
    if env and Path(env).is_file():
        return env
    which = shutil.which("aria2c")
    if which:
        return which
    # common winget path
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    if local.is_dir():
        for p in local.rglob("aria2c.exe"):
            return str(p)
    return None


def _fresh_cdn_url(url: str, token: str | None) -> str:
    """Resolve Hub → signed CDN URL. CDN rejects Authorization header (403)."""
    cmd = ["curl.exe", "-sI"]
    if token:
        cmd.extend(["-H", f"Authorization: Bearer {token}"])
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True)
    loc = None
    for line in (r.stdout or "").splitlines():
        if line.lower().startswith("location:"):
            loc = line.split(":", 1)[1].strip()
    return loc or url


def download(url: str, dest: Path, token: str | None, min_size: int = 0) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # .aria2 control file => incomplete even if size looks large (sparse/partial)
    incomplete = dest.with_suffix(dest.suffix + ".aria2").exists() or Path(str(dest) + ".aria2").exists()
    if (
        dest.exists()
        and min_size
        and dest.stat().st_size >= min_size
        and not incomplete
    ):
        print(f"  skip {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
        return dest
    if incomplete:
        print(f"  resume incomplete {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")

    aria = _find_aria2()
    # Never send Bearer to CDN: resolve redirect first, then download unsigned URL
    fetch_url = _fresh_cdn_url(url, token) if token else url
    print(f"  GET {url}")
    if fetch_url != url:
        print(f"  CDN {fetch_url.split('?', 1)[0]}")
    print(f"  -> {dest}  (aria2={bool(aria)} x={ARIA_X} s={ARIA_S})")

    if aria:
        cmd = [
            aria,
            "-c",
            "-x",
            str(ARIA_X),
            "-s",
            str(ARIA_S),
            "-k",
            ARIA_K,
            "--file-allocation=none",
            "--auto-file-renaming=false",
            "--allow-overwrite=true",
            "--max-tries=0",
            "--retry-wait=2",
            "--timeout=120",
            "--connect-timeout=30",
            # no lowest-speed-limit: Happ VPN often dips below 8KB/s per conn
            "--summary-interval=5",
            "--console-log-level=notice",
            "-d",
            str(dest.parent),
            "-o",
            dest.name,
            fetch_url,
        ]
        r = subprocess.run(cmd)
        if r.returncode != 0:
            raise RuntimeError(f"aria2c exit={r.returncode} for {url}")
    else:
        cmd = [
            "curl.exe",
            "-L",
            "--fail",
            "--retry",
            "30",
            "--retry-all-errors",
            "--retry-delay",
            "2",
            "-C",
            "-",
            "-o",
            str(dest),
        ]
        if token:
            cmd.extend(["-H", f"Authorization: Bearer {token}"])
        cmd.append(url)
        r = subprocess.run(cmd)
        if r.returncode not in (0, 18):
            raise RuntimeError(f"curl exit={r.returncode} for {url}")

    size = dest.stat().st_size if dest.exists() else 0
    if min_size and size < min_size:
        raise RuntimeError(f"too small {dest} ({size} < {min_size})")
    print(f"  OK {dest.name} ({size / 1e6:.1f} MB)")
    return dest


def download_whisper(token: str | None):
    out = WHISPER / "faster-distil-whisper-large-v3"
    print("-> Whisper distil-large-v3")
    files = [
        ("config.json", 0),
        ("tokenizer.json", 0),
        ("vocabulary.json", 0),
        ("preprocessor_config.json", 0),
        ("model.bin", 700_000_000),
    ]
    for fname, minsz in files:
        download(
            f"{HUB}/Systran/faster-distil-whisper-large-v3/resolve/main/{fname}",
            out / fname,
            token,
            min_size=minsz,
        )


def download_llm(token: str | None):
    LLM.mkdir(parents=True, exist_ok=True)
    # Prefer 7B; 3B fallback
    candidates = [
        (
            "mradermacher/Qwen2.5-7B-Instruct-abliterated-GGUF",
            "Qwen2.5-7B-Instruct-abliterated.Q4_K_M.gguf",
            4_683_074_560,  # exact X-Linked-Size from Hub
        ),
        (
            "mradermacher/Qwen2.5-3B-Instruct-abliterated-GGUF",
            "Qwen2.5-3B-Instruct-abliterated.Q4_K_M.gguf",
            1_900_000_000,
        ),
    ]
    last = None
    for repo, fname, minsz in candidates:
        print(f"-> {fname}")
        try:
            download(f"{HUB}/{repo}/resolve/main/{fname}", LLM / fname, token, min_size=minsz)
            return
        except Exception as e:
            last = e
            print("  FAIL", e)
    raise RuntimeError(f"LLM download failed: {last}")


def download_piper(token: str | None):
    voices = [
        ("ru/ru_RU/dmitri/medium", "ru_RU-dmitri-medium"),
        ("ru/ru_RU/irina/medium", "ru_RU-irina-medium"),
        ("en/en_US/lessac/medium", "en_US-lessac-medium"),
        ("en/en_US/ryan/medium", "en_US-ryan-medium"),
    ]
    for rel, name in voices:
        print(f"-> Piper {name}")
        for fname in (f"{name}.onnx", f"{name}.onnx.json"):
            minsz = 10_000_000 if fname.endswith(".onnx") else 0
            download(
                f"{HUB}/rhasspy/piper-voices/resolve/main/{rel}/{fname}",
                PIPER / fname,
                token,
                min_size=minsz,
            )


def main():
    what = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    token = _token()
    aria = _find_aria2()
    print(f"HF_TOKEN present: {bool(token)}  aria2: {aria or 'NONE'}  hub: {HUB}")
    if token:
        probe = subprocess.run(
            [
                "curl.exe",
                "-s",
                "-o",
                os.devnull,
                "-w",
                "%{http_code}",
                "-H",
                f"Authorization: Bearer {token}",
                f"{HUB}/api/whoami-v2",
            ],
            capture_output=True,
            text=True,
        )
        print(f"curl whoami HTTP={(probe.stdout or '').strip()}")

    if what in ("all", "whisper"):
        download_whisper(token)
    if what in ("all", "piper"):
        download_piper(token)
    if what in ("all", "llm"):
        download_llm(token)
    print("Done.")


if __name__ == "__main__":
    main()
