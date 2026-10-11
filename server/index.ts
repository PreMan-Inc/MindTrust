import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.ts';
import { acquireProcessLock, canonicalDatabasePath } from './process-lock.ts';

process.umask(0o077);
if (existsSync('.env')) process.loadEnvFile('.env');
const host = process.env.MINDTRUST_HOST ?? '127.0.0.1';
const token = process.env.MINDTRUST_ADMIN_TOKEN ?? '';
const production =
  process.env.MINDTRUST_MODE === 'production' || process.env.NODE_ENV === 'production';
const oidcValues = [
  process.env.MINDTRUST_OIDC_ISSUER,
  process.env.MINDTRUST_OIDC_CLIENT_ID,
  process.env.MINDTRUST_OIDC_CLIENT_SECRET,
  process.env.MINDTRUST_OIDC_REDIRECT_URI,
].map((s, index) => (index === 2 ? (s ?? '') : (s?.trim() ?? '')));
if (oidcValues.some(Boolean) && !oidcValues.every(Boolean))
  throw new Error('OIDC requires issuer, client ID, client secret, and redirect URI together');
const oidc = oidcValues.every(Boolean)
  ? {
      issuer: oidcValues[0],
      clientId: oidcValues[1],
      clientSecret: oidcValues[2],
      redirectUri: oidcValues[3],
      label: process.env.MINDTRUST_OIDC_LABEL,
    }
  : undefined;
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token)
  throw new Error('Refusing non-loopback binding without MINDTRUST_ADMIN_TOKEN.');
const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');
const requestedDbPath = resolve(process.env.MINDTRUST_DB ?? 'data/mindtrust.sqlite');
mkdirSync(dirname(requestedDbPath), { recursive: true, mode: 0o700 });
const dbPath = canonicalDatabasePath(requestedDbPath);
const releaseLock = acquireProcessLock(dbPath + '.lock');
let instance: ReturnType<typeof createApp>;
try {
  instance = createApp({
    dbPath,
    seed: production ? false : process.env.MINDTRUST_SEED !== 'false',
    adminToken: token,
    production,
    oidc,
    trustedProxies: (process.env.MINDTRUST_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedOrigins: (process.env.MINDTRUST_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    providerBaseUrl: process.env.OPENAI_BASE_URL,
    providerApiKey: process.env.OPENAI_API_KEY,
  });
} catch (error) {
  releaseLock();
  throw error;
}
const server = instance.app.listen(port, host, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'server_started',
      mode: production ? 'production' : 'development',
      host,
      port,
      authentication: token ? 'enabled' : 'local-development',
    }),
  );
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  instance.operations.drain();
  // Refuse new work, let accepted HTTP requests finish, then stop workers and
  // close storage. Incomplete persisted evaluations resume on the next start.
  const hardStop = setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_deadline_exceeded' }));
    server.closeAllConnections();
    process.exit(1);
  }, 45_000);
  hardStop.unref();
  try {
    await new Promise<void>((done) => server.close(() => done()));
    await instance.close();
    releaseLock();
    console.log(JSON.stringify({ level: 'info', event: 'server_stopped' }));
  } finally {
    clearTimeout(hardStop);
  }
}
server.on('error', async (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'server_error',
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
    }),
  );
  await instance.close();
  releaseLock();
  process.exitCode = 1;
});
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
