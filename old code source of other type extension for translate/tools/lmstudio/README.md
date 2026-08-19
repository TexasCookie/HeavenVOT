# AetherVox → LM Studio (MT)

1. Install [LM Studio](https://lmstudio.ai/).
2. Import GGUF from `../local-voice-gateway/models/llm/` (or Discover: **Qwen2.5-7B-Instruct-abliterated** Q4_K_M).
3. Load with settings from [`aethervox-mt.preset.json`](aethervox-mt.preset.json):
   - context **8192**
   - temperature **0.15**, top_p **0.9**, repeat_penalty **1.05**
   - max tokens **200**
   - **thinking / reasoning OFF**
   - no content filter / safety
4. Developer → Local Server → Start on `http://127.0.0.1:1234` (CORS on).
5. Start the voice gateway: `../local-voice-gateway` (port **8788**).
6. Extension Options → Provider **Local**.

Do not paste a moralizing system prompt in LM Studio — AetherVox sends its own (including zero-censorship rules).

**Thinking / reasoning models:** turn Thinking OFF in LM Studio (or use a non-reasoning abliterated Instruct). Otherwise `max_tokens` is eaten by `reasoning_content` and live MT stalls. The gateway also sends `reasoning_effort=none` / `enable_thinking=false` and auto-picks a mid-size abliterated model from `/v1/models`.
