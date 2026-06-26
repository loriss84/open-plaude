/**
 * poller-core.ts — logica riusabile del poller (usata da CLI e da GUI).
 *
 * runPoll(): lista le registrazioni, scarica solo le nuove (audio + metadati +
 * transcript/summary), salva su outputDir, aggiorna lo state. Se il webhook e'
 * abilitato, notifica ogni voce non ancora notificata e marca notified=true.
 */

import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Settings } from './settings.js';

const execFileP = promisify(execFile);

const CONFIG_DIR = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaud');

export interface ProcessedEntry {
  id: string;
  filename: string;
  dir: string;
  audioFile: string;
  savedAt: string;
  startTime: number;
  durationSec: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  /** path dei chunk audio per la trascrizione (vuoto se chunkMinutes=0 o ffmpeg assente) */
  chunks: string[];
  notified: boolean;
}

export interface State {
  processed: Record<string, ProcessedEntry>;
}

export interface PollResult {
  found: number;
  added: number;
  notified: number;
  errors: number;
  tracked: number;
}

export type Logger = (msg: string) => void;

function stateFile(s: Settings): string {
  return path.join(s.outputDir, '.state.json');
}

async function loadState(s: Settings): Promise<State> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(s), 'utf8')) as State;
    if (!parsed.processed) parsed.processed = {};
    return parsed;
  } catch {
    return { processed: {} };
  }
}

async function saveState(s: Settings, state: State): Promise<void> {
  const tmp = `${stateFile(s)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, stateFile(s));
}

function toDate(epoch: number): Date {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms);
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function recordingDir(s: Settings, rec: { id: string; filename: string; start_time: number }): string {
  const day = toDate(rec.start_time).toISOString().slice(0, 10);
  return path.join(s.outputDir, `${day}_${rec.id}_${safeName(rec.filename || 'rec')}`);
}

async function downloadAudioTo(
  client: PlaudClient,
  s: Settings,
  id: string,
  destDir: string,
  log: Logger,
): Promise<string> {
  if (s.audioFormat === 'mp3') {
    const url = await client.getMp3Url(id);
    if (url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`mp3 fetch HTTP ${res.status}`);
      const dest = path.join(destDir, 'audio.mp3');
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    }
    log(`  mp3 url non disponibile per ${id}, fallback a original`);
  }
  const ab = await client.downloadAudio(id);
  const dest = path.join(destDir, 'audio.bin');
  await fs.writeFile(dest, Buffer.from(ab));
  return dest;
}

/**
 * Spezza l'audio originale in chunk da `minutes` minuti (taglio senza
 * ri-codifica, qualità identica) sotto <destDir>/chunks/. Ritorna i path
 * ordinati. Best-effort: se ffmpeg manca o fallisce, ritorna [].
 */
async function chunkAudio(audioPath: string, destDir: string, minutes: number, log: Logger): Promise<string[]> {
  if (!minutes || minutes <= 0) return [];
  if (!audioPath.endsWith('.mp3')) return []; // copy-segment affidabile solo su mp3
  const chunkDir = path.join(destDir, 'chunks');
  await fs.mkdir(chunkDir, { recursive: true });
  try {
    await execFileP('ffmpeg', [
      '-y', '-i', audioPath,
      '-f', 'segment',
      '-segment_time', String(Math.round(minutes * 60)),
      '-c', 'copy',
      '-reset_timestamps', '1',
      path.join(chunkDir, 'chunk_%03d.mp3'),
    ]);
  } catch (err) {
    log(`  chunking ffmpeg fallito (${(err as Error).message}); proseguo senza chunk`);
    return [];
  }
  const files = (await fs.readdir(chunkDir))
    .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
    .sort();
  return files.map((f) => path.join(chunkDir, f));
}

/** Invia il webhook per una singola registrazione. Throwa in caso di fallimento. */
async function sendWebhook(s: Settings, entry: ProcessedEntry, extra: { transcript?: string; summary?: string; metadata: unknown }): Promise<void> {
  const payload = {
    event: 'new_recording',
    ...entry,
    transcript: extra.transcript ?? null,
    summary: extra.summary ?? null,
    metadata: extra.metadata,
  };
  const res = await fetch(s.webhook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

export async function runPoll(s: Settings, log: Logger): Promise<PollResult> {
  await fs.mkdir(s.outputDir, { recursive: true });

  const config = new PlaudConfig(CONFIG_DIR);
  if (!config.getCredentials()) {
    throw new Error(`Nessuna credenziale in ${path.join(CONFIG_DIR, 'config.json')}. Esegui prima il login.`);
  }
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, s.region);
  await auth.getToken(); // fail-fast su problemi di auth

  const state = await loadState(s);
  const recordings = await client.listRecordings();
  log(`Trovate ${recordings.length} registrazioni nel cloud Plaud.`);

  const result: PollResult = { found: recordings.length, added: 0, notified: 0, errors: 0, tracked: 0 };

  for (const rec of recordings) {
    if (rec.is_trash && !s.includeTrash) continue;
    if (state.processed[rec.id]) continue;

    try {
      log(`Nuova: ${rec.id} "${rec.filename}" (${Math.round(rec.duration / 1000)}s)`);
      const dir = recordingDir(s, rec);
      await fs.mkdir(dir, { recursive: true });

      const audioFile = await downloadAudioTo(client, s, rec.id, dir, log);
      const chunks = await chunkAudio(audioFile, dir, s.chunkMinutes, log);
      if (chunks.length) log(`  ${chunks.length} chunk audio generati`);
      const detail = await client.getRecording(rec.id);
      await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(detail, null, 2), 'utf8');
      if (detail.transcript) await fs.writeFile(path.join(dir, 'transcript.txt'), detail.transcript, 'utf8');
      if (detail.summary) await fs.writeFile(path.join(dir, 'summary.txt'), detail.summary, 'utf8');

      state.processed[rec.id] = {
        id: rec.id,
        filename: rec.filename,
        dir,
        audioFile,
        savedAt: new Date().toISOString(),
        startTime: rec.start_time,
        durationSec: Math.round(rec.duration / 1000),
        hasTranscript: Boolean(detail.transcript),
        hasSummary: Boolean(detail.summary),
        chunks,
        notified: false,
      };
      await saveState(s, state);
      result.added++;
      log(`  salvata in ${dir}`);
    } catch (err) {
      result.errors++;
      log(`  ERRORE su ${rec.id}: ${(err as Error).message}`);
    }
  }

  // Webhook: notifica le voci non ancora notificate (anche di run precedenti)
  if (s.webhook.enabled && s.webhook.url) {
    for (const entry of Object.values(state.processed)) {
      if (entry.notified) continue;
      try {
        let transcript: string | undefined;
        let summary: string | undefined;
        let metadata: unknown = {};
        try {
          metadata = JSON.parse(await fs.readFile(path.join(entry.dir, 'metadata.json'), 'utf8'));
          transcript = (metadata as { transcript?: string }).transcript;
          summary = (metadata as { summary?: string }).summary;
        } catch {
          /* metadata opzionale */
        }
        await sendWebhook(s, entry, { transcript, summary, metadata });
        entry.notified = true;
        await saveState(s, state);
        result.notified++;
        log(`  webhook OK: ${entry.id}`);
      } catch (err) {
        result.errors++;
        log(`  webhook ERRORE ${entry.id}: ${(err as Error).message}`);
      }
    }
  }

  result.tracked = Object.keys(state.processed).length;
  log(`Fatto. Nuove: ${result.added}, notificate: ${result.notified}, errori: ${result.errors}, tracciate: ${result.tracked}`);
  return result;
}

/** Stato dei download per la GUI (lista registrazioni tracciate). */
export async function readState(s: Settings): Promise<State> {
  return loadState(s);
}

/** Scadenza del token Plaud (per la GUI). */
export function readTokenExpiry(): number | null {
  try {
    const config = new PlaudConfig(CONFIG_DIR);
    const t = config.getToken();
    return t?.expiresAt ?? null;
  } catch {
    return null;
  }
}
