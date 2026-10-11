import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.ts';

const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--traces') + 1] || 2000);
const countSupplied = args.includes('--traces');
const traces = countSupplied ? count : 2000;
if (!Number.isInteger(traces) || traces < 100 || traces > 100000)
  throw new Error('--traces must be 100..100000');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const dir = await mkdtemp(join(tmpdir(), 'mindtrust-benchmark-'));
const token = randomBytes(32).toString('hex');
const instance = createApp({
  dbPath: join(dir, 'benchmark.sqlite'),
  seed: false,
  adminToken: token,
});
const server = instance.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
const base = `http://127.0.0.1:${address.port}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const latencies: number[] = [];
const api = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Benchmark request failed: ${response.status}`);
  return response.json();
};
const percentile = (a: number[], p: number) =>
  a.slice().sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * p) - 1)] ?? 0;
try {
  const project = await api('/api/projects', { name: 'Synthetic load verification' });
  let next = 0;
  const batchSize = 50,
    concurrency = 8;
  let bytes = 0;
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < traces) {
        const from = next;
        next += batchSize;
        const batch = Array.from({ length: Math.min(batchSize, traces - from) }, (_, j) => {
          const index = from + j;
          return {
            id: `synthetic-${index}`,
            name: `agent-${index % 10}`,
            input: { prompt: 'Synthetic product inquiry ' + index, context: 'x'.repeat(768) },
            output: { status: 'completed', value: index },
            status: index % 10 === 0 ? 'error' : 'ok',
            tags: ['synthetic'],
            metadata: { synthetic: true, case: index },
            startTime: new Date(1800000000000 + index).toISOString(),
            endTime: new Date(1800000000100 + index).toISOString(),
            inputTokens: 256,
            outputTokens: 32,
            costUsd: null,
          };
        });
        const payload = { projectId: project.id, traces: batch };
        bytes += Buffer.byteLength(JSON.stringify(payload));
        const t = performance.now();
        await api('/api/traces', payload);
        latencies.push(performance.now() - t);
      }
    }),
  );
  const elapsed = performance.now() - begin;
  const overview = await api(`/api/overview?projectId=${project.id}`);
  if (overview.traceCount !== traces) throw new Error('Lost traces');
  const queryLatencies: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t = performance.now();
    await api(`/api/traces?projectId=${project.id}&limit=50&offset=${i * 10}&status=error`);
    queryLatencies.push(performance.now() - t);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    scope:
      'Local synthetic single-workspace benchmark, not a Braintrust comparison or production capacity guarantee',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    configuration: {
      traces,
      batchSize,
      concurrency,
      authentication: 'Bearer',
      transport: 'HTTP loopback without TLS',
      storage: 'SQLite WAL, synchronous FULL',
      sharedDatabaseAcrossProcesses: false,
    },
    result: {
      acceptedTraces: overview.traceCount,
      errorStatusTraces: overview.errorCount,
      payloadBytes: bytes,
      ingestWallMs: elapsed,
      tracesPerSecond: traces / (elapsed / 1000),
      batchLatencyP50Ms: percentile(latencies, 0.5),
      batchLatencyP95Ms: percentile(latencies, 0.95),
      querySamples: queryLatencies.length,
      queryP50Ms: percentile(queryLatencies, 0.5),
      queryP95Ms: percentile(queryLatencies, 0.95),
      lostTraces: 0,
    },
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (out) await writeFile(out, json);
  console.log(json);
} finally {
  await instance.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
}
