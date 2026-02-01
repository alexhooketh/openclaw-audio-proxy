# openclaw-audio-proxy

A tiny **local-only** HTTP service that exposes an **OpenAI-compatible** audio transcription endpoint:

- `POST /v1/audio/transcriptions` (multipart/form-data)

…and forwards the audio to **OpenRouter** using `POST /chat/completions` with `input_audio`.

This exists because OpenClaw’s built-in “OpenAI provider” transcription path expects `/audio/transcriptions`, while OpenRouter’s audio support is currently exposed via `chat/completions` + `input_audio`.

## What it does

- Accepts an uploaded audio file (the `file` field in multipart).
- **Transcodes Telegram voice notes (OGG/Opus) to WAV** (mono, 16kHz PCM) for maximum compatibility.
- Calls OpenRouter with a strict “transcribe verbatim” instruction.
- Returns an OpenAI-style response:

```json
{ "text": "...transcript..." }
```

## Endpoints

- `GET /health` → basic status (model, baseUrl, whether an API key is present)
- `POST /v1/audio/transcriptions` → OpenAI-compatible transcription endpoint
- `POST /audio/transcriptions` → alias

## Configuration (environment variables)

Required:

- `OPENROUTER_API_KEY` – OpenRouter key (do **not** commit this)

Optional:

- `OPENROUTER_BASE_URL` (default: `https://openrouter.ai/api/v1`)
- `OPENCLAW_AUDIO_PROXY_MODEL` (default: `openai/gpt-audio-mini`)
- `OPENCLAW_AUDIO_PROXY_BIND` (default: `127.0.0.1`)
- `OPENCLAW_AUDIO_PROXY_PORT` (default: `18793`)

## Local run

```bash
npm ci
OPENROUTER_API_KEY=... \
OPENCLAW_AUDIO_PROXY_MODEL=google/gemini-2.0-flash-lite-001 \
node index.js

curl http://127.0.0.1:18793/health
```

## Example systemd user unit

This is the kind of unit we run on the VPS (adjust paths/user/env as needed):

```ini
[Unit]
Description=OpenClaw Audio Transcription Proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-audio-proxy
ExecStart=/usr/bin/node /opt/openclaw-audio-proxy/index.js
Restart=on-failure
EnvironmentFile=/root/.openclaw/.env
Environment=OPENCLAW_AUDIO_PROXY_BIND=127.0.0.1
Environment=OPENCLAW_AUDIO_PROXY_PORT=18793
Environment=OPENCLAW_AUDIO_PROXY_MODEL=google/gemini-2.0-flash-lite-001

[Install]
WantedBy=default.target
```

## Security notes

- Bind to `127.0.0.1` only (default) and don’t expose this service publicly.
- Never commit `.env` or API keys.
- The proxy does not log audio contents.

## License

MIT (or choose another license if you prefer).
