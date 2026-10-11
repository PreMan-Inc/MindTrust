import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createApp } from '../server/app.ts';
import { seedDemo } from '../server/seed-data.ts';
import { Store } from '../server/store.ts';
import { ingestOtlp, writeTrace } from '../server/traces.ts';
import type { Experiment, Project } from '../shared/types.ts';

async function fixture(options = {}) {
  const instance = createApp({ dbPath: ':memory:', seed: false, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const port = addr.port;
  async function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  return {
    ...instance,
    baseUrl: `http://127.0.0.1:${port}`,
    api,
    close: async () => {
      await instance.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test('derived trace accounting counts ancestor metrics once and explicit root values remain authoritative', () => {
  const store = new Store(':memory:');
  try {
    const p: Project = { id: 'p', name: 'P', description: '', createdAt: new Date().toISOString() };
    store.put('project', p, p.id);
    store.transaction(() =>
      writeTrace(store, p.id, {
        id: 't',
        name: 'Agent',
        spans: [
          { id: 'root', kind: 'agent', inputTokens: 20, outputTokens: 10, costUsd: 0.1 },
          {
            id: 'child',
            parentId: 'root',
            kind: 'llm',
            inputTokens: 20,
            outputTokens: 10,
            costUsd: 0.1,
          },
        ],
      }),
    );
    let trace = store.traceDetail('t').trace;
    assert.equal(trace.costUsd, 0.1);
    assert.equal(trace.inputTokens, 20);
    assert.equal(trace.outputTokens, 10);
    store.transaction(() =>
      writeTrace(store, p.id, {
        id: 't',
        name: 'Agent',
        costUsd: null,
        inputTokens: 30,
        outputTokens: 15,
      }),
    );
    store.transaction(() =>
      writeTrace(store, p.id, {
        id: 't',
        name: 'Agent',
        spans: [{ id: 'sibling', kind: 'llm', inputTokens: 5, outputTokens: 2, costUsd: 0.01 }],
      }),
    );
    trace = store.traceDetail('t').trace;
    assert.equal(trace.costUsd, null);
    assert.equal(trace.inputTokens, 30);
    assert.equal(trace.outputTokens, 15);
    assert.equal(trace.spanCount, 3);
    assert.throws(
      () =>
        store.transaction(() =>
          writeTrace(store, p.id, {
            id: 't',
            name: 'Bad',
            spans: [{ id: 'cycle', parentId: 'cycle' }],
          }),
        ),
      /cycle/,
    );
    assert.equal(store.traceDetail('t').spans.length, 3);
  } finally {
    store.close();
  }
});

test('seeding is idempotent and visibly synthetic', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const count = store.list('trace').length;
    seedDemo(store);
    assert.equal(store.list('trace').length, count);
    assert(count >= 30);
    assert(store.datasetRows('demo-dataset').every((r) => r.metadata.synthetic === true));
    assert.equal(store.setting('demoSeeded'), 'true');
    assert(store.list<Experiment>('experiment').every((e) => e.description.includes('Synthetic')));
  } finally {
    store.close();
  }
});

test('local development origin is accepted and API keys are stored as hashes', async () => {
  const f = await fixture({ adminToken: 'test-root-token' });
  try {
    const key = await f.api(
      '/keys',
      { name: 'integration' },
      { authorization: 'Bearer test-root-token', origin: 'http://127.0.0.1:5190' },
    );
    assert.equal(key.status, 201);
    const row = f.store.db.prepare('SELECT * FROM api_keys').get()!;
    assert.equal(typeof row.hash, 'string');
    assert.equal(String(row.hash).length, 64);
    assert(!JSON.stringify(row).includes(key.data.key));
  } finally {
    await f.close();
  }
});

test('parallel experiments share one bounded provider queue and cancellation remains terminal', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    active++;
    calls++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const addr = provider.address();
  assert(addr && typeof addr !== 'string');
  const f = await fixture({
    providerBaseUrl: `http://127.0.0.1:${addr.port}`,
    providerApiKey: 'fixture-key',
  });
  try {
    const p = (await f.api('/projects', { name: 'Queue' })).data;
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Tasks',
        rows: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, input: 'x', expected: 'x' })),
      })
    ).data;
    const scorer = (
      await f.api('/scorers', { projectId: p.id, name: 'Exact', type: 'exact_match' })
    ).data;
    const payload = {
      projectId: p.id,
      datasetId: d.id,
      scorerIds: [scorer.id],
      task: { type: 'openai', model: 'fixture' },
      concurrency: 16,
    };
    const a = (await f.api('/experiments', { ...payload, name: 'A' })).data,
      b = (await f.api('/experiments', { ...payload, name: 'B' })).data;
    for (let i = 0; i < 100; i++) {
      const aa = (await f.api(`/experiments/${a.id}`)).data.experiment,
        bb = (await f.api(`/experiments/${b.id}`)).data.experiment;
      if (aa.status === 'completed' && bb.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await f.api(`/experiments/${a.id}`)).data.experiment.completedCases, 20);
    assert.equal((await f.api(`/experiments/${b.id}`)).data.experiment.completedCases, 20);
    assert.equal(calls, 40);
    assert(peak <= 16, `Observed ${peak} provider calls, expected at most 16`);
    const cancel = (await f.api('/experiments', { ...payload, name: 'Cancel' })).data;
    await f.api(`/experiments/${cancel.id}/cancel`, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await f.api(`/experiments/${cancel.id}`)).data.experiment.status, 'cancelled');
  } finally {
    await f.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test('SDK imports reject content that does not match their pinned dataset', async () => {
  const f = await fixture();
  try {
    const p = (await f.api('/projects', { name: 'Comparison' })).data,
      d = (
        await f.api('/datasets', {
          projectId: p.id,
          name: 'D',
          rows: [{ id: 'a', input: 'one', expected: 'one' }],
        })
      ).data;
    const base = { projectId: p.id, datasetId: d.id, datasetVersion: 1 };
    const a = (
      await f.api('/experiments/import', {
        ...base,
        name: 'A',
        cases: [
          { rowId: 'a', input: 'one', expected: 'one', output: 'one', scores: { quality: 1 } },
        ],
      })
    ).data;
    for (const changed of [
      { input: 'different', expected: 'one' },
      { input: 'one', expected: 'tampered' },
    ]) {
      const rejected = await f.api('/experiments/import', {
        ...base,
        name: 'Invalid',
        cases: [{ rowId: 'a', ...changed, output: 'one', scores: { quality: 1 } }],
      });
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /pinned dataset/);
    }
    assert.equal(a.executionSource, 'sdk-import');
  } finally {
    await f.close();
  }
});

test('missing ground truth remains unknown while explicit null is a valid expected value', async () => {
  const f = await fixture();
  try {
    const p = (await f.api('/projects', { name: 'Ground truth' })).data;
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Null cases',
        rows: [
          { id: 'missing', input: null },
          { id: 'explicit', input: null, expected: null },
        ],
      })
    ).data;
    const scorer = (
      await f.api('/scorers', { projectId: p.id, name: 'Exact', type: 'exact_match' })
    ).data;
    const run = (
      await f.api('/experiments', {
        projectId: p.id,
        name: 'Null handling',
        datasetId: d.id,
        scorerIds: [scorer.id],
        task: { type: 'echo' },
      })
    ).data;
    let detail;
    for (let i = 0; i < 100; i++) {
      detail = (await f.api(`/experiments/${run.id}`)).data;
      if (detail.experiment.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const missing = detail.cases.find((c: any) => c.rowId === 'missing'),
      explicit = detail.cases.find((c: any) => c.rowId === 'explicit');
    assert.equal(missing.scores[scorer.id], null);
    assert.match(missing.scoreErrors[scorer.id], /no expected value/);
    assert.equal(explicit.scores[scorer.id], 1);
    const rows = (await f.api(`/datasets/${d.id}/export`)).data;
    assert.equal(rows.find((r: any) => r.id === 'missing').hasExpected, false);
    await f.api(`/datasets/${d.id}/import`, { rows });
    assert.equal(
      (await f.api(`/datasets/${d.id}`)).data.rows.find((r: any) => r.id === 'missing').hasExpected,
      false,
    );
  } finally {
    await f.close();
  }
});

test('local development rejects DNS-rebinding Host headers without relying on Origin', async () => {
  const f = await fixture();
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${f.baseUrl}/api/projects`,
        { headers: { Host: 'attacker.example' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await f.close();
  }
});

test('OTLP span IDs are scoped to trace IDs and remain unchanged in exports', () => {
  const store = new Store(':memory:');
  try {
    store.put(
      'project',
      { id: 'p', name: 'OTLP', description: '', createdAt: new Date().toISOString() },
      'p',
    );
    const spanId = 'aaaaaaaaaaaaaaaa';
    const traceIds = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
    for (const traceId of traceIds) {
      const result = ingestOtlp(
        store,
        {
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId,
                      spanId,
                      name: 'Root',
                      startTimeUnixNano: '1791633600000000000',
                      endTimeUnixNano: '1791633600010000000',
                    },
                  ],
                },
              ],
            },
          ],
        },
        'p',
      );
      assert.deepEqual(result, {});
      assert.equal(store.traceDetail(traceId).spans[0].id, spanId);
    }
    assert.equal(store.list('span').length, 2);
  } finally {
    store.close();
  }
});
