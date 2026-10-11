import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Scorer } from '../sdk/index';

// The distributed runtime is .mjs, while the separately shipped declarations are index.d.ts.
const sdkModule = '../sdk/index.mjs';
const { MindTrust, scorers } = (await import(sdkModule)) as typeof import('../sdk/index');

type JsonRecord = Record<string, any>;
type RequestRecord = { path: string; method: string; authorization?: string; body: JsonRecord };
type Reply = { status?: number; body?: unknown };

async function fixture(handler: (request: RequestRecord) => Reply | Promise<Reply>) {
  const requests: RequestRecord[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const record = {
        path: request.url || '/',
        method: request.method || 'GET',
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      };
      requests.push(record);
      const result = await handler(record);
      response.writeHead(result.status || 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body ?? { ok: true }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dataset(rows: JsonRecord[], version = 7) {
  return { dataset: { id: 'data-1', projectId: 'project-1', version }, rows };
}

test('SDK rejects invalid timeout and trace capacity before performing work', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new MindTrust({ projectId: 'p', maxBufferedTraces: value }),
      /maxBufferedTraces/,
    );
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, 4_294_967_296]) {
    assert.throws(() => new MindTrust({ projectId: 'p', timeoutMs: value }), /timeoutMs/);
  }
  assert.doesNotThrow(() => new MindTrust({ projectId: 'p', maxBufferedTraces: 1, timeoutMs: 1 }));
});

test('concurrent root traces retain async child parentage and propagate original errors', async (t) => {
  const api = await fixture(() => ({}));
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    apiKey: 'fixture-key',
  });
  const original = new Error('tool failed');
  await Promise.all([
    client.trace('root-a', { input: 'A' }, async (span) => {
      await Promise.all([
        span.trace('child-a1', { kind: 'tool' }, async (child) => {
          await delay(8);
          return child.trace('grandchild-a', async () => 'nested');
        }),
        span.trace('child-a2', async () => {
          await delay(1);
          return 'parallel';
        }),
      ]);
      return 'A done';
    }),
    client.trace('root-b', async (span) => {
      await delay(2);
      return span.trace('child-b', async () => 'B done');
    }),
    assert.rejects(
      client.trace('root-error', async (span) => {
        return span.trace('child-error', async () => {
          await delay(3);
          throw original;
        });
      }),
      (error) => error === original,
    ),
  ]);
  await client.flush();
  const traces = api.requests.flatMap((request) => request.body.traces || []) as JsonRecord[];
  assert.equal(traces.length, 3);
  const a = traces.find((trace) => trace.name === 'root-a')!;
  const b = traces.find((trace) => trace.name === 'root-b')!;
  const failed = traces.find((trace) => trace.name === 'root-error')!;
  const byName = (trace: JsonRecord, name: string) =>
    trace.spans.find((span: JsonRecord) => span.name === name);
  assert.equal(byName(a, 'child-a1').parentId, byName(a, 'root-a').id);
  assert.equal(byName(a, 'child-a2').parentId, byName(a, 'root-a').id);
  assert.equal(byName(a, 'grandchild-a').parentId, byName(a, 'child-a1').id);
  assert.equal(byName(b, 'child-b').parentId, byName(b, 'root-b').id);
  assert.notEqual(a.id, b.id);
  assert.equal(a.spans.length, 4);
  assert.equal(b.spans.length, 2);
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.output, { error: 'tool failed' });
  assert.ok(failed.spans.every((span: JsonRecord) => span.status === 'error' && span.endTime));
  assert.ok(
    traces.every((trace) => trace.spans.every((span: JsonRecord) => span.traceId === trace.id)),
  );
  assert.equal(api.requests[0].authorization, 'Bearer fixture-key');
});

test('a full buffer never masks a task exception and remains explicitly observable', async (t) => {
  const api = await fixture(() => ({}));
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    maxBufferedTraces: 1,
  });
  client.log({ id: 'kept', name: 'already buffered' });
  const original = new Error('application failure');
  await assert.rejects(
    client.trace('failure', async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.match(client.lastLoggingError?.message || '', /buffer is full/);
  await assert.rejects(
    client.trace('success with full buffer', async () => 'done'),
    /buffer is full/,
  );
  await client.flush();
  assert.deepEqual(
    api.requests[0].body.traces.map((trace: JsonRecord) => trace.id),
    ['kept'],
  );
});

test('concurrent flush shares failed work, retains its batch, and retries stable IDs', async (t) => {
  let attempts = 0;
  const stored = new Map<string, JsonRecord>();
  const api = await fixture(async (request) => {
    if (++attempts === 1) {
      await delay(5);
      return { status: 503, body: { error: 'retry me' } };
    }
    await delay(3);
    for (const trace of request.body.traces) stored.set(trace.id, trace);
    return {};
  });
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    maxBufferedTraces: 102,
  });
  for (let i = 0; i < 101; i++) client.log({ id: `trace-${i}`, name: `trace ${i}` });
  const failures = await Promise.allSettled([client.flush(), client.flush()]);
  assert.ok(failures.every((result) => result.status === 'rejected'));
  assert.equal(api.requests.length, 1);
  const retry = client.flush();
  client.log({ id: 'trace-101', name: 'added during flush' });
  await retry;
  assert.equal(stored.size, 102);
  assert.deepEqual(
    api.requests.map((request) => request.body.traces.length),
    [100, 100, 2],
  );
  assert.deepEqual(api.requests[0].body.traces, api.requests[1].body.traces);
  await client.flush();
  assert.equal(api.requests.length, 3, 'an empty flush must not issue another request');
});

test('evaluation pins a revision, bounds concurrency, separates task/scorer failures and uses 1-based trials', async (t) => {
  let imported: JsonRecord | undefined;
  let currentVersion = 7;
  const rows = [
    { id: 'row-1', input: { n: 1 }, expected: { answer: 1 }, metadata: { source: 'original' } },
    { id: 'row-2', input: { n: 2 }, expected: 'unused', metadata: {} },
    { id: 'row-3', input: { n: 3 }, metadata: {} },
  ];
  const api = await fixture((request) => {
    if (request.method === 'GET') return { body: dataset(rows, currentVersion) };
    if (request.path === '/api/experiments/import') {
      imported = request.body;
      return { body: { id: 'experiment-1' } };
    }
    return {};
  });
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    maxBufferedTraces: 2,
  });
  let active = 0,
    maximum = 0;
  const custom: Scorer[] = [
    scorers.exactMatch,
    {
      name: 'Throws',
      score: () => {
        throw new Error('judge unavailable');
      },
    },
    { name: 'Too large', score: () => 1.01 },
    { name: 'Not finite', score: () => NaN },
  ];
  const result = await client.evaluate({
    name: 'frozen dataset',
    datasetId: 'data-1',
    datasetVersion: 7,
    trials: 2,
    concurrency: 2,
    scorers: custom,
    task: async (input, context) => {
      currentVersion = 8;
      maximum = Math.max(maximum, ++active);
      try {
        const original = (input as { n: number }).n;
        (input as { n: number }).n = 99;
        context.metadata.source = 'modified by task';
        assert.ok(context.trial === 1 || context.trial === 2);
        await delay(4);
        if (original === 2) throw new Error('task failed deliberately');
        return original === 3 ? null : { answer: 1 };
      } finally {
        active--;
      }
    },
  });
  assert.equal(result.id, 'experiment-1');
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(api.requests.filter((request) => request.method === 'GET').length, 1);
  assert.equal(api.requests[0].path, '/api/datasets/data-1?version=7');
  assert.equal(imported?.datasetVersion, 7);
  assert.equal(imported?.cases.length, 6);
  assert.deepEqual(
    imported?.cases.map((row: JsonRecord) => row.trial),
    [1, 2, 1, 2, 1, 2],
  );
  for (const row of imported!.cases) {
    assert.notEqual(row.input.n, 99);
    if (row.rowId === 'row-2') {
      assert.equal(row.error, 'task failed deliberately');
      assert.ok(Object.values(row.scores).every((value) => value === null));
      assert.ok(Object.values(row.scoreErrors).every((value) => value === 'Task failed'));
    } else {
      assert.equal(row.error, null);
      assert.equal(row.scores['Exact match'], row.rowId === 'row-1' ? 1 : 0);
      assert.equal(row.scores.Throws, null);
      assert.equal(row.scoreErrors.Throws, 'judge unavailable');
      assert.match(row.scoreErrors['Too large'], /finite number from 0 to 1/);
      assert.match(row.scoreErrors['Not finite'], /finite number from 0 to 1/);
    }
  }
  const traces = api.requests.flatMap((request) => request.body.traces || []);
  assert.equal(traces.length, 6);
  assert.ok(traces.every((trace) => trace.metadata.datasetVersion === 7));
  assert.ok(
    api.requests
      .filter((request) => request.body.traces)
      .every((request) => request.body.traces.length <= 2),
  );
});

test('evaluation keeps captured usage even when another scorer flushes its trace', async (t) => {
  let imported: JsonRecord | undefined;
  const api = await fixture((request) => {
    if (request.method === 'GET')
      return {
        body: dataset([
          { id: 'one', input: 1, expected: 1 },
          { id: 'two', input: 2, expected: 2 },
        ]),
      };
    if (request.path === '/api/experiments/import') imported = request.body;
    return {};
  });
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    maxBufferedTraces: 4,
  });
  const flushed = deferred();
  await client.evaluate({
    name: 'flush race',
    datasetId: 'data-1',
    concurrency: 2,
    task: async (input, { span }) => {
      span.update({
        inputTokens: Number(input) * 10,
        outputTokens: Number(input),
        costUsd: Number(input) / 10,
      });
      return input;
    },
    scorers: [
      {
        name: 'flush while scoring',
        score: async ({ input }) => {
          if (input === 1) await flushed.promise;
          else {
            await client.flush();
            flushed.resolve();
          }
          return 1;
        },
      },
    ],
  });
  assert.deepEqual(
    imported!.cases.map((row: JsonRecord) => [row.inputTokens, row.outputTokens, row.costUsd]),
    [
      [10, 1, 0.1],
      [20, 2, 0.2],
    ],
  );
});

test('an evaluation waits for active workers before rejecting a failed delivery', async (t) => {
  const failedDelivery = deferred();
  const releaseSlowTask = deferred();
  const api = await fixture((request) => {
    if (request.method === 'GET')
      return {
        body: dataset(
          Array.from({ length: 6 }, (_, i) => ({ id: `row-${i}`, input: i, expected: i })),
        ),
      };
    if (request.path === '/api/traces') {
      failedDelivery.resolve();
      return { status: 503, body: { error: 'delivery failed' } };
    }
    return {};
  });
  t.after(api.close);
  const client = new MindTrust({
    baseUrl: api.baseUrl,
    projectId: 'project-1',
    maxBufferedTraces: 2,
  });
  let started = 0,
    active = 0,
    rejected = false;
  const evaluation = client.evaluate({
    name: 'failure lifecycle',
    datasetId: 'data-1',
    concurrency: 2,
    task: async (input) => {
      started++;
      active++;
      try {
        if (input === 1) await releaseSlowTask.promise;
        return input;
      } finally {
        active--;
      }
    },
  });
  const observed = evaluation.catch((error) => {
    rejected = true;
    return error;
  });
  await failedDelivery.promise;
  await delay(10);
  assert.equal(
    rejected,
    false,
    'the caller must not receive failure while another worker is still active',
  );
  assert.equal(active, 1);
  releaseSlowTask.resolve();
  assert.match((await observed).message, /503.*delivery failed/);
  assert.equal(active, 0);
  assert.equal(started, 2, 'stop scheduling new cases once delivery fails');
  assert.equal(
    api.requests.filter((request) => request.path === '/api/experiments/import').length,
    0,
  );
});

test('builtin scorers agree on JSON values, absent expectations and invalid content', async () => {
  const score = (scorer: Scorer, output: any, expected?: any) =>
    scorer.score({ input: null, output, expected, metadata: {} });
  assert.equal(await score(scorers.exactMatch, { a: 1, b: 2 }, { b: 2, a: 1 }), 1);
  assert.equal(await score(scorers.exactMatch, null), 0);
  assert.equal(await score(scorers.exactMatch, null, null), 1);
  assert.equal(await score(scorers.contains, { answer: 42 }, 42), 1);
  assert.equal(await score(scorers.contains, 'anything', ''), 0);
  assert.equal(await score(scorers.contains, null), 0);
  for (const output of [{ valid: true }, [1, 2], '{"ok":true}', 'null', '42'])
    assert.equal(await score(scorers.jsonValid, output), 1);
  for (const output of [null, 42, 'not json'])
    assert.equal(await score(scorers.jsonValid, output), 0);
});

test('trace totals do not double count metered parents and preserve unknown model cost', async (t) => {
  const api = await fixture(() => ({}));
  t.after(api.close);
  const client = new MindTrust({ baseUrl: api.baseUrl, projectId: 'project-1' });
  await client.trace('aggregate', async (root) => {
    await root.trace(
      'metered aggregate',
      { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
      async (parent) => {
        await parent.trace(
          'included model',
          { kind: 'llm', inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
          async () => 'result',
        );
      },
    );
    await root.trace(
      'separate model',
      { kind: 'llm', inputTokens: 30, outputTokens: 5, costUsd: 0.1 },
      async () => 'result',
    );
  });
  await client.trace('unknown pricing', async (root) => {
    await root.trace('priced model', { kind: 'llm', costUsd: 0.5 }, async () => 'a');
    await root.trace('unpriced model', { kind: 'llm' }, async () => 'b');
  });
  await client.flush();
  const [aggregate, unknown] = api.requests[0].body.traces;
  assert.equal(aggregate.inputTokens, 130);
  assert.equal(aggregate.outputTokens, 25);
  assert.equal(aggregate.costUsd, 0.6);
  assert.equal(unknown.costUsd, null);
});
