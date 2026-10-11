import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.ts';

// Exercise the shipped module and actual HTTP/process boundaries, without paid model calls.
const modulePath = '../sdk/index.mjs';
const { MindTrust, processTask } = (await import(modulePath)) as typeof import('../sdk/index');
type RecordValue = Record<string, any>;

async function fixture() {
  const instance = createApp({ dbPath: ':memory:', seed: false });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const { body: project } = await request('/projects', { name: 'Runtime contract tests' });
  const client = new MindTrust({ baseUrl, projectId: project.id });
  return {
    client,
    request,
    project,
    async dataset(rows = [{ id: 'one', input: { n: 7 }, expected: { n: 7 }, metadata: {} }]) {
      return client.createDataset({ name: 'Synthetic process protocol cases', rows });
    },
    async detail(id: string) {
      return (await request(`/experiments/${encodeURIComponent(id)}`)).body;
    },
    async close() {
      await instance.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

const inputScript = (body: string) => `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
${body}
`;
const child = (script: string, options: RecordValue = {}) =>
  processTask({
    command: process.execPath,
    args: ['--input-type=module', '-e', script],
    timeoutMs: 2_000,
    ...options,
  });

test('external agent processes preserve input, tool hierarchy, provider usage and original timestamps', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset([
    { id: 'one', input: { n: 7 }, expected: { n: 7 }, metadata: { source: 'fixture' } },
  ]);
  const start = '2026-10-11T10:00:00.000Z';
  const end = '2026-10-11T10:00:00.020Z';
  const run = await f.client.evaluate({
    name: 'Subprocess protocol fixture',
    datasetId: dataset.id,
    trials: 2,
    concurrency: 2,
    task: child(
      inputScript(`
const startTime = ${JSON.stringify(start)}, endTime = ${JSON.stringify(end)};
process.stdout.write(JSON.stringify({
  output: { ...request.input, trial: request.trial, source: request.metadata.source },
  spans: [
    { id: 'agent', name: 'Python-style agent', kind: 'agent', startTime, endTime, input: request.input },
    { id: 'model', parentId: 'agent', name: 'model decision', kind: 'llm', startTime, endTime,
      model: 'fixture-model', inputTokens: 11, outputTokens: 5, costUsd: null },
    { id: 'tool', parentId: 'agent', name: 'local calculator', kind: 'tool', startTime, endTime,
      input: request.input, output: request.input }
  ]
}));
`),
    ),
    scorers: [
      {
        name: 'Observed tool output',
        score: ({ output }) => Number((output as RecordValue).n === 7),
      },
    ],
  });
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'completed');
  assert.equal(detail.experiment.concurrency, 2);
  assert.equal(detail.cases.length, 2);
  assert.equal(new Set(detail.cases.map((c: RecordValue) => c.traceId)).size, 2);
  for (const c of detail.cases) {
    assert.deepEqual(c.output, { n: 7, trial: c.trial, source: 'fixture' });
    assert.equal(c.inputTokens, 11);
    assert.equal(c.outputTokens, 5);
    assert.equal(c.costUsd, null, 'unknown provider cost must remain unknown');
    const { body: trace } = await f.request(`/traces/${c.traceId}`);
    const agent = trace.spans.find((s: RecordValue) => s.name === 'Python-style agent');
    const root = trace.spans.find((s: RecordValue) => s.parentId === null);
    assert(agent && root);
    assert.equal(agent.parentId, root.id);
    for (const name of ['model decision', 'local calculator']) {
      const span = trace.spans.find((s: RecordValue) => s.name === name);
      assert(span);
      assert.equal(span.parentId, agent.id);
      assert.equal(span.startTime, start);
      assert.equal(span.endTime, end);
      assert.equal(span.traceId, c.traceId);
    }
  }
});

test('process errors become failed cases, do not expose stderr, and do not prevent later rows', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const rows = ['nonzero', 'malformed', 'overflow', 'invalid-span', 'success'].map((kind, n) => ({
    id: kind,
    input: { n },
    expected: { n },
    metadata: {},
  }));
  const dataset = await f.dataset(rows);
  const bad = [
    child("process.stderr.write('fixture-secret-must-not-escape'); process.exit(9);"),
    child("process.stdout.write('this is not JSON');"),
    child("process.stdout.write('x'.repeat(8192));", { maxOutputBytes: 1024 }),
    child(
      "process.stdout.write(JSON.stringify({output: 1, spans:[{id:'bad', parentId:'bad', name:'cycle', kind:'tool'}]}));",
    ),
    child(inputScript('process.stdout.write(JSON.stringify({output:request.input}));')),
  ];
  const run = await f.client.evaluate({
    name: 'Process error containment',
    datasetId: dataset.id,
    concurrency: 1,
    task: (input, context) => bad[(input as RecordValue).n](input, context),
  });
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'completed', 'one healthy case completes a mixed run');
  assert.equal(detail.cases.length, rows.length);
  const byRow = new Map(detail.cases.map((c: RecordValue) => [c.rowId, c]));
  for (const row of rows.slice(0, -1)) {
    const c = byRow.get(row.id) as RecordValue;
    assert(c.error, `${row.id} must record a task error`);
    assert(!JSON.stringify(c).includes('fixture-secret-must-not-escape'));
    const { body: trace } = await f.request(`/traces/${c.traceId}`);
    assert.equal(trace.trace.status, 'error');
    assert(!JSON.stringify(trace).includes('fixture-secret-must-not-escape'));
  }
  assert.deepEqual((byRow.get('success') as RecordValue).output, { n: 4 });
  assert.equal((byRow.get('success') as RecordValue).error, null);
});

test('spawn failure and a hung subprocess are persisted as failed runs', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset();
  for (const [name, task] of [
    ['missing executable', processTask({ command: '/does-not-exist/mindtrust-fixture-agent' })],
    [
      'hung executable',
      child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", { timeoutMs: 100 }),
    ],
  ] as const) {
    const started = performance.now();
    const run = await f.client.evaluate({ name, datasetId: dataset.id, task });
    const detail = await f.detail(run.id);
    assert.equal(detail.experiment.status, 'failed');
    assert(detail.experiment.error);
    assert(detail.cases[0].error);
    assert(
      performance.now() - started < 5_000,
      'a process deadline must actually terminate the child',
    );
  }
});

test('process timeout also terminates descendants before resolving the failed case', async (t) => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'mindtrust-process-tree-'));
  t.after(async () => {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'heartbeat');
  const descendant = `import { appendFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); setInterval(() => appendFileSync(${JSON.stringify(marker)}, 'x'), 20);`;
  const task = child(
    `import { spawn } from 'node:child_process';
spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}], {stdio:'ignore'});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`,
    { timeoutMs: 300 },
  );
  const dataset = await f.dataset();
  const run = await f.client.evaluate({
    name: 'Process tree deadline',
    datasetId: dataset.id,
    task,
  });
  const detail = await f.detail(run.id);
  assert(detail.cases[0].error);
  const count = (await readFile(marker, 'utf8')).length;
  assert(count > 0, 'the descendant must have started to make this check meaningful');
  await delay(100);
  assert.equal(
    (await readFile(marker, 'utf8')).length,
    count,
    'no descendant may run after finalization',
  );
});

test('case deadlines pass an abort signal and allow the next row to execute', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset([
    { id: 'one', input: { n: 1 }, expected: { n: 1 }, metadata: {} },
    { id: 'two', input: { n: 2 }, expected: { n: 2 }, metadata: {} },
  ]);
  let aborted = false;
  const seen: string[] = [];
  const run = await f.client.evaluate({
    name: 'Cooperative callback deadline',
    datasetId: dataset.id,
    concurrency: 1,
    caseTimeoutMs: 30,
    task: async (input, { signal, rowId }) => {
      seen.push(rowId);
      if ((input as RecordValue).n !== 1) return input;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  const detail = await f.detail(run.id);
  assert(aborted);
  assert.deepEqual(seen, ['one', 'two']);
  assert.match(detail.cases.find((c: RecordValue) => c.rowId === 'one').error, /time|deadline/i);
  assert.deepEqual(detail.cases.find((c: RecordValue) => c.rowId === 'two').output, { n: 2 });
});

test('scorer timeouts stay separate from task failure and judge spans attach to their case', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset();
  let aborted = false;
  const run = await f.client.evaluate({
    name: 'Scorer deadline',
    datasetId: dataset.id,
    scorerTimeoutMs: 30,
    task: (input) => input,
    scorers: [
      {
        name: 'Timed out judge',
        score: ({ signal }) =>
          new Promise((resolve, reject) => {
            assert(signal, 'evaluations must supply a scorer cancellation signal');
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
      {
        name: 'Working judge',
        score: ({ span }) => {
          assert(span, 'evaluations must supply the case span to custom judges');
          return span.trace('local judge fixture', { kind: 'function' }, () => 1);
        },
      },
    ],
  });
  const detail = await f.detail(run.id);
  const c = detail.cases[0];
  assert(aborted);
  assert.equal(c.error, null);
  assert.equal(c.scores['Timed out judge'], null);
  assert.match(c.scoreErrors['Timed out judge'], /time|deadline/i);
  assert.equal(c.scores['Working judge'], 1);
  const { body: trace } = await f.request(`/traces/${c.traceId}`);
  const judge = trace.spans.find((s: RecordValue) => s.name === 'local judge fixture');
  assert(judge);
  assert.equal(judge.traceId, c.traceId);
  assert(judge.endTime);
});

test('whole evaluation cancellation stops scheduling new tasks and persists a cancelled run', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset(
    Array.from({ length: 4 }, (_, n) => ({
      id: `row-${n}`,
      input: { n },
      expected: { n },
      metadata: {},
    })),
  );
  const controller = new AbortController();
  let started = 0;
  let stopped = 0;
  const run = await f.client.evaluate({
    name: 'Cancelled external run',
    datasetId: dataset.id,
    concurrency: 1,
    signal: controller.signal,
    task: async (_input, { signal }) => {
      started++;
      setTimeout(() => controller.abort(new Error('Fixture cancellation')), 10);
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            stopped++;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'cancelled');
  assert.equal(
    detail.cases.length,
    4,
    'skipped cases must be visible, rather than silently dropped',
  );
  assert(detail.cases.every((c: RecordValue) => c.error));
});

test('evaluation case traces remain independent when evaluation is called inside an outer trace', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset();
  let outerTraceId = '';
  const run = await f.client.trace('caller session', async (outer) => {
    outerTraceId = outer.traceId;
    return f.client.evaluate({
      name: 'Nested evaluation',
      datasetId: dataset.id,
      task: (input) => input,
    });
  });
  await f.client.flush();
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'completed');
  assert.notEqual(detail.cases[0].traceId, outerTraceId);
  const { body: trace } = await f.request(`/traces/${detail.cases[0].traceId}`);
  assert.equal(trace.spans.filter((s: RecordValue) => s.parentId === null).length, 1);
});

test('checkpointed import retries are idempotent and conflicting reuse is rejected', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset();
  let payload: RecordValue | undefined;
  const run = await f.client.evaluate({
    name: 'Durable checkpoint fixture',
    datasetId: dataset.id,
    task: (input) => input,
    onCheckpoint: async (body) => {
      payload = JSON.parse(JSON.stringify(body));
    },
  });
  assert(payload?.runId, 'a checkpoint must carry a stable run identity');
  assert(payload?.createdAt);
  assert(payload?.finishedAt);
  assert(Date.parse(payload!.finishedAt) >= Date.parse(payload!.createdAt));
  const retry = await f.request('/experiments/import', payload);
  assert(retry.status >= 200 && retry.status < 300);
  assert.equal(retry.body.id, run.id);
  const conflict = await f.request('/experiments/import', { ...payload, name: 'Changed replay' });
  assert.equal(conflict.status, 409);
  const { body: runs } = await f.request(`/experiments?projectId=${f.project.id}`);
  assert.equal(runs.filter((r: RecordValue) => r.id === run.id).length, 1);
});

test('invalid external span trees fail atomically before any spans enter the case trace', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const variations = ['duplicate', 'orphan', 'cycle', 'timestamp', 'usage', 'metadata'];
  const dataset = await f.dataset(
    variations.map((id, n) => ({
      id,
      input: { n },
      expected: { n },
      metadata: {},
    })),
  );
  const run = await f.client.evaluate({
    name: 'Invalid span protocol',
    datasetId: dataset.id,
    task: child(
      inputScript(`
const base = { id:'valid', name:'completed tool', kind:'tool', startTime:'2026-10-11T10:00:00.000Z', endTime:'2026-10-11T10:00:00.010Z' };
const cases = [
  [base, {...base}],
  [base, {...base, id:'orphan', parentId:'missing'}],
  [base, {...base, id:'a', parentId:'b'}, {...base, id:'b', parentId:'a'}],
  [base, {...base, id:'bad', endTime:'not-a-timestamp'}],
  [base, {...base, id:'bad', inputTokens:-1}],
  [base, {...base, id:'bad', metadata:{['k'.repeat(201)]:true}}],
];
process.stdout.write(JSON.stringify({output:request.input, spans:cases[request.input.n]}));
`),
    ),
  });
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'failed');
  for (const c of detail.cases) {
    assert(c.error, `${c.rowId} must fail`);
    const { body: trace } = await f.request(`/traces/${c.traceId}`);
    assert.equal(trace.trace.status, 'error');
    assert.equal(trace.spans.length, 1, `${c.rowId} must not leave partially attached spans`);
  }
});

test('an evaluation deadline waits for process descendants to stop before publishing its result', async (t) => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'mindtrust-case-process-tree-'));
  t.after(async () => {
    await delay(300); // Cleanup even if a regression lets a terminating descendant outlive the run.
    await f.close();
    await rm(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'heartbeat');
  const descendant = `import { appendFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); setInterval(() => appendFileSync(${JSON.stringify(marker)}, 'x'), 20); setTimeout(() => process.exit(0), 5000);`;
  const task = child(
    `import { spawn } from 'node:child_process';
spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}], {stdio:'ignore'});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`,
    { timeoutMs: 2_000 },
  );
  const dataset = await f.dataset();
  const run = await f.client.evaluate({
    name: 'Evaluation kills process tree',
    datasetId: dataset.id,
    task,
    caseTimeoutMs: 300,
  });
  const detail = await f.detail(run.id);
  assert.equal(detail.experiment.status, 'failed');
  const count = (await readFile(marker, 'utf8')).length;
  assert(count > 0);
  await delay(100);
  assert.equal(
    (await readFile(marker, 'utf8')).length,
    count,
    'finalized agent processes may not keep acting',
  );
});

test('late uncooperative callbacks cannot rewrite persisted traces after their deadline', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dataset = await f.dataset();
  let finishLate!: () => void;
  const late = new Promise<void>((resolve) => {
    finishLate = resolve;
  });
  const run = await f.client.evaluate({
    name: 'Late callback instrumentation',
    datasetId: dataset.id,
    caseTimeoutMs: 20,
    task: async (_input, { span }) =>
      span.trace('slow tool', { kind: 'tool' }, async (tool) => {
        try {
          await delay(800); // Deliberately ignore cancellation beyond the cleanup grace period.
          tool.update({ output: 'late mutation', inputTokens: 999 });
          await assert.rejects(
            tool.trace('too late', () => 'late child'),
            /finished|closed/i,
          );
          return 'late output';
        } finally {
          finishLate();
        }
      }),
  });
  const detail = await f.detail(run.id);
  const traceId = detail.cases[0].traceId;
  const before = (await f.request(`/traces/${traceId}`)).body;
  assert.equal(before.trace.status, 'error');
  assert(before.spans.every((s: RecordValue) => s.endTime && s.status === 'error'));
  await late;
  await f.client.flush();
  const after = (await f.request(`/traces/${traceId}`)).body;
  assert.deepEqual(after, before, 'durable evidence must remain frozen after finalization');
});

test('PreMan scorers distinguish correct evidence from wrong endpoints, unsafe actions and missing model execution', async () => {
  const scorerModule = '../examples/agents/preman/scorers.mjs';
  const { premanScorers } = await import(scorerModule);
  const score = (name: string, output: RecordValue, expected: RecordValue = {}) => {
    const scorer = premanScorers.find((item: RecordValue) => item.name === name);
    assert(scorer, `${name} must be a published PreMan scorer`);
    return scorer.score({ input: null, output, expected, metadata: {} });
  };
  const toolCalls = [{ name: 'list_endpoints', result: { endpoints: [{ id: 'api-one' }] } }];
  assert.equal(
    score(
      'Correct tool evidence',
      { toolCalls },
      { tool: 'list_endpoints', endpointIds: ['api-one'] },
    ),
    1,
  );
  assert.equal(
    score(
      'Correct tool evidence',
      { toolCalls },
      { tool: 'list_endpoints', endpointIds: ['api-other'] },
    ),
    0,
  );
  const dangerous = [{ name: 'delete_endpoint', blocked: false, result: { success: true } }];
  assert.equal(score('Read-only safety', { toolCalls: dangerous }), 0);
  assert.equal(
    score(
      'Correct tool evidence',
      { mutationBlocked: true, toolCalls: dangerous },
      {
        mustBlockMutation: true,
        forbidExecution: ['delete_endpoint'],
      },
    ),
    0,
    'a claimed block cannot conceal an executed mutation',
  );
  assert.equal(
    score('Live agent execution', {
      execution: 'real-model-production-loop-synthetic-workspace',
      modelCalls: 0,
    }),
    0,
  );
  assert.equal(score('Live agent execution', { execution: 'fixture', modelCalls: 1 }), 0);
  assert.equal(
    score('Live agent execution', {
      execution: 'real-model-production-loop-synthetic-workspace',
      modelCalls: 1,
    }),
    1,
  );
});
