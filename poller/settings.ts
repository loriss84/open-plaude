/**
 * settings.ts — configurazione condivisa tra poller e GUI.
 *
 * Le impostazioni vivono in <DATA_DIR>/settings.json (modificabili dalla GUI).
 * I default partono dalle env (retrocompatibili con la v1 CLI).
 * Lo state dei download resta in <outputDir>/.state.json (fonte di verita').
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type Region = 'us' | 'eu';
export type AudioFormat = 'mp3' | 'original';

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  /** 'metadata' = JSON con path NFS + metadati; 'multipart' = (futuro) file binario */
  mode: 'metadata' | 'multipart';
}

export interface Settings {
  outputDir: string;
  region: Region;
  audioFormat: AudioFormat;
  includeTrash: boolean;
  pollIntervalMin: number;
  /** minuti per chunk audio (per la trascrizione); 0 = nessun chunk */
  chunkMinutes: number;
  webhook: WebhookSettings;
}

export const DATA_DIR = process.env.PLAUD_DATA_DIR ?? path.join(process.cwd(), 'data');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOG_FILE = path.join(DATA_DIR, 'poller.log');

export function defaultSettings(): Settings {
  const fallbackOut =
    process.platform === 'win32'
      ? path.join(process.cwd(), 'test-output')
      : '/mnt/nfs/plaud';
  return {
    outputDir: process.env.PLAUD_OUTPUT_DIR ?? fallbackOut,
    region: (process.env.PLAUD_REGION as Region) ?? 'eu',
    audioFormat: (process.env.PLAUD_AUDIO_FORMAT as AudioFormat) ?? 'mp3',
    includeTrash: process.env.PLAUD_INCLUDE_TRASH === 'true',
    pollIntervalMin: Number(process.env.PLAUD_POLL_INTERVAL_MIN ?? 5),
    chunkMinutes: Number(process.env.PLAUD_CHUNK_MINUTES ?? 10),
    webhook: { enabled: false, url: '', mode: 'metadata' },
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const d = defaultSettings();
    return { ...d, ...parsed, webhook: { ...d.webhook, ...(parsed.webhook ?? {}) } };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await fs.rename(tmp, SETTINGS_FILE);
}

/** Validazione/sanitizzazione di un payload settings ricevuto dalla GUI. */
export function sanitizeSettings(input: unknown): Settings {
  const d = defaultSettings();
  const i = (input ?? {}) as Record<string, unknown>;
  const wh = (i.webhook ?? {}) as Record<string, unknown>;
  return {
    outputDir: typeof i.outputDir === 'string' && i.outputDir.trim() ? i.outputDir : d.outputDir,
    region: i.region === 'us' || i.region === 'eu' ? i.region : d.region,
    audioFormat: i.audioFormat === 'original' ? 'original' : 'mp3',
    includeTrash: Boolean(i.includeTrash),
    pollIntervalMin: Math.max(1, Math.min(1440, Number(i.pollIntervalMin) || d.pollIntervalMin)),
    chunkMinutes: Math.max(0, Math.min(60, Number(i.chunkMinutes) ?? d.chunkMinutes)),
    webhook: {
      enabled: Boolean(wh.enabled),
      url: typeof wh.url === 'string' ? wh.url.trim() : '',
      mode: wh.mode === 'multipart' ? 'multipart' : 'metadata',
    },
  };
}
