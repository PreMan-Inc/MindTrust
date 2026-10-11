import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.ts';

const sdkPath = '../sdk/index.mjs';
const { MindTrust, processTask } = (await import(sdkPath)) as typeof import('../sdk/index');
type JsonRecord = Record<string, any>;

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

// A real MindTrust API behind a controllable failing HTTP hop. Agent work stays local.
async function fixture() {
  const instance = createApp({ dbPath: ':memory:', seed: false });
  const apiServer = createServer(instance.app);
  const upstream = await listen(apiServer);
  let failTraceWrites = false;
  const requests: string[] = [];
  const gateway = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push(`${request.method} ${request.url}`);
      if (failTraceWrites && request.method === 'POST' && request.url === '/api/traces') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Trace delivery unavailable' }));
        return;
      }
      const result = await fetch(`${upstream}${request.url}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        ...(body.length ? { body } : {}),
      });
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Test gateway failed' }));
    }
  });
  const baseUrl = await listen(gateway);
  const bootstrap = new MindTrust({ baseUrl, projectId: 'bootstrap' });
  const project = await bootstrap.request('/projects', { name: 'Agent delivery regression' });
  return {
    requests,
    client(maxBufferedTraces = 1000) {
      return new MindTrust({ baseUrl, projectId: project.id, maxBufferedTraces });
    },
    failTraces(value: boolean) {
      failTraceWrites = value;
    },
    async dataset(count: number) {
      return this.client().createDataset({
        name: 'Paid-work stand-in cases',
        rows: Array.from({ length: count }, (_, n) => ({ id: `row-${n}`, input: n, expected: n })),
      });
    },
    async close() {
      await closeServer(gateway);
      await instance.close();
      await closeServer(apiServer);
    },
  };
}

async function rejectedResult(work: Promise<unknown>) {
  try {
    await work;
    assert.fail('The unavailable delivery must reject the evaluation');
  } catch (error) {
    assert(error instanceof Error);
    const recoverable = error as Error & { result?: JsonRecord };
    assert(recoverable.result, 'Completed agent work must be attached to the failure');
    return recoverable.result;
  }
}

const correct = [{ name: 'Correct', score: () => 1 }];

test('a mid-run trace outage retains partial case results and imports them without rerunning agents', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset(2);
  const client = f.client(1);
  let executions = 0;
  f.failTraces(true);
  const payload = await rejectedResult(
    client.evaluate({
      name: 'Interrupted delivery',
      datasetId: dataset.id,
      concurrency: 1,
      task: (input) => {
        executions++;
        return input;
      },
      scorers: correct,
    }),
  );
  assert.equal(executions, 1);
  assert.equal(payload.plannedCases, 2);
  assert.equal(payload.interrupted, true);
  assert.equal(payload.cases.length, 1);
  assert.equal(payload.cases[0].scores.Correct, 1);
  assert.equal(payload.pendingTraces.length, 1);
  assert.equal(payload.pendingTraces[0].id, payload.cases[0].traceId);

  f.failTraces(false);
  const recoveredClient = f.client(); // Simulate a new process using the saved checkpoint.
  const run = await recoveredClient.importEvaluation(JSON.parse(JSON.stringify(payload)));
  assert.equal(executions, 1, 'Recovery must never call the paid agent again');
  const detail = await recoveredClient.request(`/experiments/${run.id}`);
  assert.equal(detail.experiment.status, 'failed');
  assert.equal(detail.experiment.totalCases, 2);
  assert.equal(detail.experiment.completedCases, 1);
  assert(detail.experiment.error);
  assert.equal(detail.cases.length, 1);
  const trace = await recoveredClient.request(`/traces/${detail.cases[0].traceId}`);
  assert.equal(trace.trace.output, 0);
  assert.equal(
    (await recoveredClient.importEvaluation(payload)).id,
    run.id,
    'Delivery retry is idempotent',
  );
});

test('a final trace outage exposes complete recoverable results even without onCheckpoint', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset(1);
  const client = f.client();
  let executions = 0;
  f.failTraces(true);
  const payload = await rejectedResult(
    client.evaluate({
      name: 'Final delivery failure',
      datasetId: dataset.id,
      task: (input) => {
        executions++;
        return input;
      },
      scorers: correct,
    }),
  );
  assert.equal(payload.plannedCases, 1);
  assert.equal(Boolean(payload.interrupted), false);
  assert.equal(payload.cases.length, 1);
  assert.equal(payload.pendingTraces.length, 1);
  f.failTraces(false);
  const recoveredClient = f.client();
  const run = await recoveredClient.importEvaluation(payload);
  const detail = await recoveredClient.request(`/experiments/${run.id}`);
  assert.equal(detail.experiment.status, 'completed');
  assert.equal(detail.experiment.completedCases, 1);
  assert.equal(executions, 1);
});

test('a failing checkpoint callback cannot discard already completed agent work', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset(1);
  const client = f.client();
  const payload = await rejectedResult(
    client.evaluate({
      name: 'Checkpoint write failure',
      datasetId: dataset.id,
      task: (input) => input,
      scorers: correct,
      onCheckpoint: () => {
        throw new Error('Synthetic disk unavailable');
      },
    }),
  );
  assert.equal(payload.cases.length, 1);
  assert.equal(payload.pendingTraces.length, 1);
  assert.equal(payload.cases[0].scores.Correct, 1);
  assert.equal(f.requests.filter((path) => path === 'POST /api/experiments/import').length, 0);
  const run = await f.client().importEvaluation(payload);
  assert.equal(run.completedCases, 1);
});

test('concurrent workers serialize checkpoint writes and preserve monotonic progress', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset(6);
  const client = f.client(3);
  const checkpoints: JsonRecord[] = [];
  let active = 0,
    peak = 0;
  const run = await client.evaluate({
    name: 'Serialized checkpoints',
    datasetId: dataset.id,
    concurrency: 2,
    task: async (input) => {
      await delay(5);
      return input;
    },
    scorers: correct,
    onCheckpoint: async (payload) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(20);
        checkpoints.push(JSON.parse(JSON.stringify(payload)));
      } finally {
        active--;
      }
    },
  });
  assert.equal(peak, 1, 'An atomic checkpoint writer must not be called concurrently');
  assert(checkpoints.length > 1, 'Mid-run delivery must checkpoint before final delivery');
  for (let n = 1; n < checkpoints.length; n++)
    assert(
      checkpoints[n].cases.length >= checkpoints[n - 1].cases.length,
      'A later checkpoint must not erase progress',
    );
  assert.equal(checkpoints.at(-1)?.cases.length, 6);
  assert.equal(checkpoints.at(-1)?.plannedCases, 6);
  assert.equal(Boolean(checkpoints.at(-1)?.interrupted), false);
  assert.equal(run.completedCases, 6);
});

test(
  'a successful subprocess reaps descendants holding inherited output pipes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mindtrust-inherited-pipes-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const marker = join(directory, 'heartbeat');
    const descendant = `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)},'x'); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
    const script = `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
const wait=setInterval(()=>{
  if(fs.existsSync(${JSON.stringify(marker)})) {
    clearInterval(wait); console.log(JSON.stringify({output:'done'})); process.exit(0);
  }
},10);
`;
    const task = processTask({ command: process.execPath, args: ['-e', script], timeoutMs: 1000 });
    const output = await task(null, {
      metadata: {},
      trial: 1,
      span: {} as any,
      signal: new AbortController().signal,
    });
    assert.equal(output, 'done', 'The direct child completed successfully before its timeout');
    const count = (await readFile(marker, 'utf8')).length;
    assert(count > 0, 'A real descendant must have held the inherited pipes');
    await delay(80);
    assert.equal(
      (await readFile(marker, 'utf8')).length,
      count,
      'Descendants must be stopped before the task resolves',
    );
  },
);
