# n8n workflow — Plaud → transcribe → summarize → Notion

This folder documents the n8n side of the pipeline. Import
`plaud-to-notion.workflow.json` and adjust credentials + your Notion database id,
or rebuild it from the node reference below.

## Pipeline

```
Webhook → Read/Write Files (read audio) → STT (ElevenLabs) → diarizza
       → split → MAP (LLM per chunk) → estrai partial → Aggregate
       → reduce-prep → REDUCE (LLM) → Code Notion → Notion create page
       → append batches → Notion append
```

## Credentials (n8n → Credentials → Header Auth)

| Name | Header | Value |
|------|--------|-------|
| ElevenLabs | `xi-api-key` | `<your ElevenLabs key>` (raw, no "Bearer") |
| OpenRouter | `Authorization` | `Bearer <your OpenRouter key>` |
| Notion | `Authorization` | `Bearer <your Notion integration token>` |

Also share your Notion database with the integration (database → ⋯ → Connections).

## Node reference

### Read/Write Files from Disk (read)
- File Selector: `={{ $json.body.audioFile }}` → binary property `data`

### STT — ElevenLabs (HTTP Request)
- `POST https://api.elevenlabs.io/v1/speech-to-text`, Header Auth = ElevenLabs
- Body: multipart/form-data
  - `file` = Form Binary Data, input field `data`
  - `model_id` = `scribe_v2`
  - `diarize` = `true`
  - (optional) `language_code` — leave empty for auto-detect
- Options → Timeout: `600000`

### diarizza (Code) — speaker-labelled transcript
```js
const r = $json;
const words = r.words || [];
let out = '', cur = null;
for (const w of words) {
  if (w.type === 'audio_event') continue;
  if (w.speaker_id && w.speaker_id !== cur) { out += (out ? '\n' : '') + w.speaker_id + ': '; cur = w.speaker_id; }
  out += w.text;
}
return [{ json: { transcript: out.trim() || r.text || '', language: r.language_code } }];
```

### split (Code) — chunk the transcript
```js
const transcript = $json.transcript || '';
const MAX = 24000; // chars per chunk (~14 min of speech)
const lines = transcript.split('\n');
const chunks = [];
let buf = '';
for (const line of lines) {
  if (buf && buf.length + line.length + 1 > MAX) { chunks.push(buf); buf = ''; }
  buf += (buf ? '\n' : '') + line;
}
if (buf.trim()) chunks.push(buf);
return chunks.map((text, i) => ({ json: { chunkIndex: i + 1, total: chunks.length, chunkText: text } }));
```

### MAP — LLM per chunk (HTTP Request, OpenRouter)
JSON body (expression). System prompt instructs faithful, detailed extraction
**in the same language as the input** (so it follows the meeting's language):
```
={
  "model": "deepseek/deepseek-v4-flash",
  "max_tokens": 4000,
  "temperature": 0.2,
  "messages": [
    { "role": "system", "content": {{ JSON.stringify("You are a meticulous note-taker processing SEGMENT " + $json.chunkIndex + " of " + $json.total + " of a meeting. Extract, IN THE SAME LANGUAGE as the provided text, EVERYTHING said in detail and faithfully: topics, sub-points, concrete details (names, roles, numbers, dates, acronyms, codes, versions), decisions, proposals, open questions. Do NOT compress away details, do NOT invent anything. Return detailed bullet notes only, no preamble.") }} },
    { "role": "user", "content": {{ JSON.stringify($json.chunkText) }} }
  ]
}
```

### estrai partial (Code)
```js
return $input.all().map(it => ({ json: { partial: it.json.choices?.[0]?.message?.content || '' } }));
```

### Aggregate
- Aggregate Individual Fields → field `partial`

### reduce-prep (Code) — combine + final prompt
Joins the per-segment notes and builds the final, exhaustive summary prompt
(in the meeting's language). See the workflow JSON for the full template.

### REDUCE — LLM (HTTP Request, OpenRouter)
```
={
  "model": "deepseek/deepseek-v4-flash",
  "max_tokens": 12000,
  "temperature": 0.3,
  "messages": [
    { "role": "system", "content": {{ JSON.stringify($json.sysPrompt) }} },
    { "role": "user", "content": {{ JSON.stringify("Title: " + $json.title + "\nDate: " + $json.dateLabel + "\n\nPer-segment notes (merge into one report):\n\n" + $json.combined) }} }
  ]
}
```

### Code Notion — markdown → Notion blocks (+ title + batching)
Converts the markdown summary into real Notion blocks (headings, bullets, numbered
lists, bold, tables), derives the page title from the summary's `# H1`, and splits
blocks into a first batch (≤100) + remaining batches (Notion allows max 100 blocks
per request). Set your `database_id` and verify the title/date property names. Full
code is in the workflow JSON.

### Notion create page (HTTP Request)
- `POST https://api.notion.com/v1/pages`, Header Auth = Notion
- Headers: `Notion-Version: 2022-06-28`, `Content-Type: application/json`
- Body (JSON): `={{ JSON.stringify($json.createBody) }}`

### append batches (Code)
```js
const pageId = $json.id;
const rest = $('Code Notion').first().json.restBatches || [];
return rest.map((blocks, i) => ({ json: { pageId, batchIndex: i, children: blocks } }));
```

### Notion append (HTTP Request)
- `PATCH https://api.notion.com/v1/blocks/{{ $json.pageId }}/children`, Header Auth = Notion
- Headers: `Notion-Version: 2022-06-28`, `Content-Type: application/json`
- Body (JSON): `={{ JSON.stringify({ children: $json.children }) }}`

## Notes

- **Activate** the workflow so the production webhook (`/webhook/plaud`) is live;
  background executions appear under **Executions**, not on the canvas.
- The LLM model is just a string in the MAP/REDUCE bodies — swap it any time.
- For very long meetings the map-reduce keeps the summary from skipping details.
