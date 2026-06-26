

import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { runPoll, readState, readTokenExpiry, type PollResult } from './poller-core.js';
import {
  loadSettings,
  saveSettings,
  sanitizeSettings,
  LOG_FILE,
  DATA_DIR,
  type Settings,
} from './settings.js';
import { DASHBOARD_HTML } from './dashboard.js';

const PORT = Number(process.env.PLAUD_GUI_PORT ?? 8787);

// --- Auth (HTTP Basic). Attiva solo se PLAUD_GUI_PASSWORD e' impostata. ---
const GUI_USER = process.env.PLAUD_GUI_USER ?? 'admin';
const GUI_PASS = process.env.PLAUD_GUI_PASSWORD ?? '';
const AUTH_ENABLED = GUI_PASS.length > 0;

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // confronta entrambi sempre (evita short-circuit timing)
  const okUser = timingSafeEqual(user, GUI_USER);
  const okPass = timingSafeEqual(pass, GUI_PASS);
  return okUser && okPass;
}

let settings: Settings;
let running = false;
let lastRun: string | null = null;
let lastResult: PollResult | null = null;
let lastError: string | null = null;
let nextRunTs: number | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;

const logBuffer: string[] = [];
const LOG_CAP = 800;

async function log(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > LOG_CAP) logBuffer.splice(0, logBuffer.length - LOG_CAP);
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

async function runNow(trigger: string): Promise<{ started: boolean; reason?: string }> {
  if (running) return { started: false, reason: 'già in esecuzione' };
  running = true;
  void log(`--- Run (${trigger}) ---`);
  try {
    lastResult = await runPoll(settings, (m) => void log(m));
    lastError = null;
  } catch (err) {
    lastError = (err as Error).message;
    void log(`FATAL: ${lastError}`);
  } finally {
    running = false;
    lastRun = new Date().toISOString();
  }
  return { started: true };
}

function schedule(): void {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  const ms = settings.pollIntervalMin * 60_000;
  nextRunTs = Date.now() + ms;
  scheduleTimer = setTimeout(async () => {
    await runNow('scheduler');
    schedule();
  }, ms);
}

// ----------------------------- HTTP helpers -------------------------------

function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body troppo grande'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ----------------------------- Router -------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Plaud Poller", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Autenticazione richiesta');
    return;
  }

  if (p === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  if (p === '/api/status' && method === 'GET') {
    const tokenExpiry = readTokenExpiry();
    sendJson(res, 200, {
      running,
      lastRun,
      lastResult,
      lastError,
      nextRunTs,
      pollIntervalMin: settings.pollIntervalMin,
      region: settings.region,
      outputDir: settings.outputDir,
      webhookEnabled: settings.webhook.enabled,
      tokenExpiry,
      now: Date.now(),
    });
    return;
  }

  if (p === '/api/recordings' && method === 'GET') {
    const state = await readState(settings);
    const list = Object.values(state.processed).sort((a, b) => b.startTime - a.startTime);
    sendJson(res, 200, list);
    return;
  }

  if (p === '/api/logs' && method === 'GET') {
    const n = Math.min(Number(url.searchParams.get('lines') ?? 200), LOG_CAP);
    sendJson(res, 200, { lines: logBuffer.slice(-n) });
    return;
  }

  if (p === '/api/settings' && method === 'GET') {
    sendJson(res, 200, settings);
    return;
  }

  if (p === '/api/settings' && method === 'POST') {
    try {
      const incoming = JSON.parse(await readBody(req));
      settings = sanitizeSettings(incoming);
      await saveSettings(settings);
      schedule(); // applica subito il nuovo intervallo
      void log(`Impostazioni aggiornate (intervallo ${settings.pollIntervalMin} min, webhook ${settings.webhook.enabled ? 'ON' : 'OFF'})`);
      sendJson(res, 200, settings);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (p === '/api/run' && method === 'POST') {
    const r = await runNow('manuale'); // non await-iamo il polling completo? lo facciamo: e' ok
    sendJson(res, 200, r);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// ----------------------------- Bootstrap ----------------------------------

async function main(): Promise<void> {
  settings = await loadSettings();
  await log(`Avvio GUI su http://0.0.0.0:${PORT} — output: ${settings.outputDir}, region: ${settings.region}`);
  await log(
    AUTH_ENABLED
      ? `Auth Basic ATTIVA (utente: ${GUI_USER})`
      : `Auth DISATTIVA (imposta PLAUD_GUI_PASSWORD per proteggere la GUI)`,
  );

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message });
      } catch {
        /* response già inviata */
      }
    });
  });
  server.listen(PORT, '0.0.0.0');

  // primo run poco dopo l'avvio, poi schedulato
  setTimeout(() => void runNow('avvio'), 4000);
  schedule();
}

main().catch((err) => {
  console.error('FATAL server:', (err as Error).message);
  process.exit(1);
});
