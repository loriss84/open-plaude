

import { promises as fs } from 'node:fs';
import { runPoll } from './poller-core.js';
import { loadSettings, LOG_FILE, DATA_DIR } from './settings.js';

async function log(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* logging best-effort */
  }
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const res = await runPoll(settings, (m) => void log(m));
  if (res.errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  void log(`FATAL: ${(err as Error).message}`);
  process.exit(1);
});
