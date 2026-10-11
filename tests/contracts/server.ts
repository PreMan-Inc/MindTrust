import { once } from 'node:events';
import { createApp } from '../../server/app.ts';

// A fresh, authenticated, in-memory instance; never load the developer's .env.
const runtime = createApp({
  dbPath: ':memory:',
  seed: false,
  adminToken: 'synthetic-python-contract-key',
});
const server = runtime.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing fixture address');
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + '\n');
async function stop() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
