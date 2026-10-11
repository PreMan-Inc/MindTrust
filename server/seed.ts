import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { seedDemo } from './seed-data.ts';
if (existsSync('.env')) process.loadEnvFile('.env');
const store = new Store(process.env.MINDTRUST_DB ?? resolve('data/mindtrust.sqlite'));
try {
  seedDemo(store);
  console.log('Synthetic MindTrust demo is ready (idempotent seed; no provider calls).');
} finally {
  store.close();
}
