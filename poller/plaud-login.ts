
import { PlaudConfig, PlaudAuth } from '@plaud/core';
import * as os from 'node:os';
import * as path from 'node:path';

async function main(): Promise<void> {
  const email = process.env.PLAUD_EMAIL;
  const password = process.env.PLAUD_PASSWORD;
  const region = (process.env.PLAUD_REGION ?? 'eu') as 'us' | 'eu';
  const configDir = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaud');

  if (!email || !password) {
    throw new Error('Servono PLAUD_EMAIL e PLAUD_PASSWORD nelle env.');
  }

  const config = new PlaudConfig(configDir);
  config.saveCredentials({ email, password, region });
  console.log(`Credenziali salvate in ${path.join(configDir, 'config.json')}`);

  const auth = new PlaudAuth(config);
  const token = await auth.getToken();
  console.log(`Login OK. Token (primi 12): ${token.slice(0, 12)}...`);
}

main().catch((err) => {
  console.error(`Login FALLITO: ${(err as Error).message}`);
  process.exit(1);
});
