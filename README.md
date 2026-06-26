# open-plaud

Self-hosted pipeline to pull your **Plaud** voice-recorder audio out of the manufacturer cloud, store it on **your own NAS**, transcribe it (with speaker diarization), summarize it with the LLM of your choice, and push clean notes into **Notion** — paying **per use** instead of a monthly subscription.

> ⚠️ **Unofficial / reverse-engineered.** This project talks to Plaud's private cloud API the same way the official app does (email + password login). It is not affiliated with or endorsed by Plaud, may break if they change their API, and may be against their Terms of Service. Use it with your own account and at your own risk.

---

## Why

- **Own your data** — recordings live on your NAS, not someone else's cloud.
- **Pay per use** — transcription/summarization are billed by API usage (cents per recording) instead of a flat subscription.
- **Swappable everything** — pick any transcription provider and any LLM; the summary model can change per run.

## Architecture

```
Plaud cloud ──(poller, every N min)──► NFS share on your NAS
                                            │ webhook (new recording)
                                            ▼
   n8n:  read audio ─► transcribe + diarize (ElevenLabs Scribe)
         ─► map-reduce summarization (OpenRouter / any LLM)
         ─► create page in Notion (full markdown rendering)
```

Two independent pieces:

1. **The poller** (`poller/`) — a small TypeScript service that runs on a Linux box (e.g. a Proxmox LXC). It logs into Plaud, downloads only new recordings (dedup by file id), writes `audio.mp3` + metadata to an NFS folder, optionally splits long audio into chunks, and fires a webhook. It also serves a small web dashboard (logs, settings, manual run, HTTP Basic auth).
2. **The n8n workflow** (`n8n/`) — receives the webhook, transcribes the audio, summarizes it, and writes a Notion page.

## How the poller works

- Polls `listRecordings()` on a schedule; anything whose Plaud `id` is not yet in the local `state.json` is **new**.
- Downloads audio + metadata to `<outputDir>/<date>_<id>_<name>/`, marks the entry `notified: false`.
- A separate pass sends the webhook for every `notified: false` entry, then flips it to `true`. Download and notify are **decoupled and retryable** — if n8n is down, it retries on the next poll.
- Idempotent and crash-safe (state is written after every recording).

## Requirements

- A Plaud account **with a password set** (the app defaults to OTP; this login flow needs email + password).
- Node.js **20+** (22 recommended).
- [`plaud-toolkit`](https://github.com/sergivalverde/plaud-toolkit) — the poller builds on its `@plaud/core` library for auth + API client.
- A NAS/NFS share (or any writable directory).
- For the n8n side: an [n8n](https://n8n.io) instance, plus API keys for your transcription provider (e.g. [ElevenLabs](https://elevenlabs.io)) and LLM router (e.g. [OpenRouter](https://openrouter.ai)), and a Notion integration.

## Quick start (poller)

```bash
# 1. Clone plaud-toolkit (provides @plaud/core) and install its deps
git clone https://github.com/sergivalverde/plaud-toolkit.git
cd plaud-toolkit && npm install

# 2. Copy this repo's poller files into the toolkit
cp /path/to/open-plaud/poller/*.ts .

# 3. One-time login (writes ~/.plaud/config.json)
PLAUD_EMAIL='you@example.com' PLAUD_PASSWORD='your-password' PLAUD_REGION=eu \
  npx tsx plaud-login.ts

# 4. Run the service (dashboard + scheduler)
PLAUD_OUTPUT_DIR=/mnt/nfs/plaud PLAUD_REGION=eu npx tsx server.ts
# open http://localhost:8787
```

For a full production deploy (Proxmox LXC, NFS, systemd, n8n install), see **[docs/DEPLOY-lxc.md](docs/DEPLOY-lxc.md)**.

## Configuration (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `PLAUD_OUTPUT_DIR` | `/mnt/nfs/plaud` | where recordings are written |
| `PLAUD_REGION` | `eu` | `eu` or `us` |
| `PLAUD_AUDIO_FORMAT` | `mp3` | `mp3` or `original` |
| `PLAUD_CHUNK_MINUTES` | `10` | split audio into N-min chunks (0 = off) |
| `PLAUD_POLL_INTERVAL_MIN` | `5` | polling interval |
| `PLAUD_GUI_PORT` | `8787` | dashboard port |
| `PLAUD_GUI_USER` / `PLAUD_GUI_PASSWORD` | `admin` / _(empty)_ | dashboard Basic auth (empty = open) |
| `PLAUD_DATA_DIR` | `./data` | `settings.json` + `poller.log` |
| `PLAUD_CONFIG_DIR` | `~/.plaud` | Plaud credentials/token |

The dashboard writes a `data/settings.json` that overrides these at runtime (output dir, region, interval, webhook URL, etc.).

## The n8n workflow

Import `n8n/plaud-to-notion.workflow.json` into n8n and wire up three credentials (Header Auth):
transcription provider, LLM router, and Notion. The pipeline:

```
Webhook → read audio → STT (transcribe + diarize)
        → split transcript → map (summarize each chunk) → reduce (merge into one report)
        → markdown → Notion (create page + batched block append)
```

See `n8n/README.md` for setup details and the per-node configuration.

## Cost

Pure pay-per-use. Transcription dominates the cost and depends on your provider (e.g. ElevenLabs Scribe ~ a few cents per hour of audio, cheaper options exist without diarization); the LLM summary is typically **cents per meeting**. No flat subscription.

## Roadmap / ideas

- Speaker **identification** by voiceprint (named speakers instead of `speaker_0/1`).
- "Ask my meetings" retrieval layer.
- Pluggable output targets beyond Notion.

## Credits

- [`plaud-toolkit`](https://github.com/sergivalverde/plaud-toolkit) by sergivalverde — the Plaud API client this builds on.
- [n8n](https://n8n.io), [ElevenLabs](https://elevenlabs.io), [OpenRouter](https://openrouter.ai), [Notion](https://notion.so).

## License

MIT — see [LICENSE](LICENSE).
