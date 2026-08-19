# AetherVox local voice gateway

xAI-compatible local STT + TTS + chat proxy. **Zero content moderation.**

## Quick start

Default path uses **hf-mirror.com** (no HF token). LLM: download inside **LM Studio Discover** UI.

```bash
cd tools/local-voice-gateway
python -m pip install -r requirements.txt
python download_models.py whisper   # optional if already present
# LM Studio: load any abliterated chat model, Start Server :1234
python server.py                    # http://127.0.0.1:8788/v1
```

Extension → Options → Provider **Local** (base `http://127.0.0.1:8788/v1`).

## Autostart (Windows, recommended)

One-time Native Messaging host so the extension can start the gateway itself (and Windows Startup keeps it alive):

1. Reload the unpacked extension and copy its ID from `chrome://extensions` (or Options → **Автозапуск шлюза**).
2. From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File tools/local-voice-gateway/install-native-host.ps1 -ExtensionId YOUR_EXT_ID
```

3. Reload the extension again → **Проверить Local**.

After that, Local mode no longer needs a manual `python server.py` each session.

## Endpoints

| Path | Backend |
|------|---------|
| `POST /v1/stt` | Faster-Whisper (local `faster-whisper-tiny`, no HF token) |
| `POST /v1/tts` | Piper onnx, else Windows SAPI |
| `GET /v1/tts/voices` | Mapped ara/orion/… |
| `POST /v1/chat/completions` | LM Studio `:1234`, else llama-cpp + local GGUF |

## Env

- `LM_STUDIO_BASE` (default `http://127.0.0.1:1234/v1`)
- `AV_GATEWAY_PORT` (default `8788`)
- `AV_WHISPER_MODEL` / `AV_WHISPER_FALLBACK`
- `AV_LOCAL_GGUF` — path to abliterated Qwen GGUF
- `AV_WHISPER_DEVICE=cuda` if CUDA available

No moderation middleware. Profanity / NSFW / dark humor pass through unchanged.
