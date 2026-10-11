import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.ts';
if (existsSync('.env')) process.loadEnvFile('.env');
const host = process.env.MINDTRUST_HOST ?? '127.0.0.1';
const token = process.env.MINDTRUST_ADMIN_TOKEN ?? '';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) {
  console.error('Refusing non-loopback binding without MINDTRUST_ADMIN_TOKEN.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}
const { app, close } = createApp({
  dbPath: process.env.MINDTRUST_DB ?? resolve('data/mindtrust.sqlite'),
  seed: process.env.MINDTRUST_SEED !== 'false',
  adminToken: token,
  providerBaseUrl: process.env.OPENAI_BASE_URL,
  providerApiKey: process.env.OPENAI_API_KEY,
});
const server = app.listen(port, host, () => {
  console.log(
    `MindTrust is listening at http://${host.includes(':') ? `[${host}]` : host}:${port}`,
  );
  console.log(
    token
      ? 'API authentication enabled.'
      : 'Local development mode: API authentication is disabled.',
  );
});
server.on('error', async (error) => {
  console.error(error.message);
  await close();
  process.exitCode = 1;
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeIdleConnections();
  await close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
