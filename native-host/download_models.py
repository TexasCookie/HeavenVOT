from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
REPO = "mijuanlo/nllb-200-distilled-600M-ct2-int8"
DEST = MODELS / "nllb-200-distilled-600M-ct2-int8"


def main() -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    print(f"downloading {REPO} -> {DEST}")
    snapshot_download(repo_id=REPO, local_dir=str(DEST))
    print("done")


if __name__ == "__main__":
    main()
