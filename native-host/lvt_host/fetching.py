from __future__ import annotations

from urllib.parse import urlparse
from urllib.request import Request, urlopen

ALLOWED_CAPTION_HOSTS = frozenset(
    {
        "www.youtube.com",
        "youtube.com",
        "m.youtube.com",
        "www.youtube-nocookie.com",
    }
)


def validate_caption_url(url: str):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("unsupported_url")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_CAPTION_HOSTS:
        raise ValueError("unsupported_url")
    if parsed.username or parsed.password:
        raise ValueError("unsupported_url")
    return parsed


def fetch_caption_url(url: str, timeout: float = 15.0) -> str:
    validate_caption_url(url)
    request = Request(url, headers={"User-Agent": "lvt-host/0.1"})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 — host allowlisted
        raw = response.read(2_000_000)
    return raw.decode("utf-8", errors="replace")
