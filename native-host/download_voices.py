from __future__ import annotations

from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent / "models" / "piper"
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES = {
    "ru_RU-dmitri-medium": "ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium",
    "ru_RU-irina-medium": "ru/ru_RU/irina/medium/ru_RU-irina-medium",
    "en_US-joe-medium": "en/en_US/joe/medium/en_US-joe-medium",
    "en_US-lessac-medium": "en/en_US/lessac/medium/en_US-lessac-medium",
}


def pull(rel: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 1000:
        print("have", dest.name)
        return
    url = BASE + "/" + rel
    print("get", url)
    with urlopen(url, timeout=120) as resp:
        dest.write_bytes(resp.read())
    print("ok", dest.name, dest.stat().st_size)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, rel in VOICES.items():
        pull(rel + ".onnx", ROOT / (name + ".onnx"))
        pull(rel + ".onnx.json", ROOT / (name + ".onnx.json"))
    print("voices ready", ROOT)


if __name__ == "__main__":
    main()
