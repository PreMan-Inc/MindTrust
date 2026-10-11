import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';

async function fixture(options: Record<string, unknown> = {}) {
  const instance = createApp({ dbPath: ':memory:', seed: false, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = async (
    path: string,
    body?: unknown,
    method?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${baseUrl}${path.startsWith('/v1') ? path : `/api${path}`}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const close = async () => {
    await instance.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return { api, close, baseUrl };
}
async function project(api: Awaited<ReturnType<typeof fixture>>['api']) {
  const result = await api('/projects', {
    name: 'Integration test',
    description: 'Synthetic test data',
  });
  assert.equal(result.status, 201);
  return result.data;
}
async function completed(api: Awaited<ReturnType<typeof fixture>>['api'], id: string) {
  for (let i = 0; i < 100; i++) {
    const { data } = await api(`/experiments/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(data.experiment.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Evaluation did not complete');
}

test('traces persist across restart, upsert without losing children, and preserve unknown costs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindtrust-persistence-'));
  const dbPath = join(directory, 'test.sqlite');
  let app = await fixture({ dbPath });
  try {
    const p = await project(app.api);
    const span = {
      id: 'child',
      parentId: 'root',
      name: 'lookup',
      kind: 'tool',
      startTime: '2026-10-10T12:00:00.000Z',
      endTime: '2026-10-10T12:00:00.010Z',
      input: { q: 'a' },
      output: 'b',
    };
    const payload = {
      projectId: p.id,
      traces: [
        {
          id: 'trace-1',
          name: 'agent',
          input: 'hello',
          output: 'world',
          startTime: span.startTime,
          endTime: span.endTime,
          costUsd: null,
          spans: [{ ...span, id: 'root', parentId: null, kind: 'agent' }, span],
        },
      ],
    };
    assert.equal((await app.api('/traces', payload)).status, 201);
    await app.api('/traces', {
      projectId: p.id,
      traces: [{ id: 'trace-1', name: 'agent', output: 'updated' }],
    });
    let detail = (await app.api('/traces/trace-1')).data;
    assert.equal(detail.spans.length, 2);
    assert.equal(detail.trace.output, 'updated');
    assert.equal(detail.trace.costUsd, null);
    assert.equal((await app.api(`/traces?projectId=${p.id}`)).data.total, 1);
    await app.close();
    app = await fixture({ dbPath });
    detail = (await app.api('/traces/trace-1')).data;
    assert.equal(detail.spans.find((s: any) => s.id === 'child').parentId, 'root');
    assert.equal(detail.trace.output, 'updated');
    const exported = (await app.api(`/traces/export?projectId=${p.id}`)).data;
    assert.equal(exported.length, 1);
    assert.equal(exported[0].spans.length, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('dataset snapshots survive edits/deletes and malformed imports are atomic', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Cases',
        rows: [{ id: 'a', input: 'one', expected: 'one' }],
      })
    ).data;
    assert.equal(d.version, 1);
    await f.api(`/datasets/${d.id}/rows`, {
      rows: [
        { id: 'a', input: 'two', expected: 'two' },
        { id: 'b', input: 'three', expected: 'three' },
      ],
    });
    const old = (await f.api(`/datasets/${d.id}?version=1`)).data;
    assert.equal(old.rows[0].input, 'one');
    assert.equal(old.rows.length, 1);
    const bad = await f.api(`/datasets/${d.id}/import`, {
      rows: [{ input: 'valid', expected: 'valid' }, { tags: 'invalid' }],
    });
    assert(bad.status >= 400 && bad.status < 500);
    assert.equal((await f.api(`/datasets/${d.id}`)).data.dataset.version, 2);
    await f.api(`/datasets/${d.id}/rows/b`, undefined, 'DELETE');
    assert.equal((await f.api(`/datasets/${d.id}`)).data.rows.length, 1);
    assert.equal((await f.api(`/datasets/${d.id}?version=2`)).data.rows.length, 2);
    await f.api(`/datasets/${d.id}/import`, {
      rows: [
        {
          _id: 'legacy-case',
          input: { q: 'a' },
          expected: 'b',
          metadata: { source: 'braintrust-export' },
          tags: ['migration'],
        },
      ],
    });
    assert((await f.api(`/datasets/${d.id}/export`)).data.some((r: any) => r.id === 'legacy-case'));
  } finally {
    await f.close();
  }
});

test('evaluations pin data, run repeated cases, and disclose incompatible comparisons', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Evaluate',
        rows: [
          { id: 'a', input: { text: 'a' }, expected: 'a' },
          { id: 'b', input: { text: 'b' }, expected: 'b' },
        ],
      })
    ).data;
    const scorer = (
      await f.api('/scorers', { projectId: p.id, name: 'Exact', type: 'exact_match' })
    ).data;
    const config = {
      projectId: p.id,
      datasetId: d.id,
      scorerIds: [scorer.id],
      task: { type: 'template', template: '{{input.text}}' },
      trials: 2,
      concurrency: 2,
    };
    const run = await f.api('/experiments', { ...config, name: 'baseline' });
    assert.equal(run.status, 202);
    await f.api(`/datasets/${d.id}/rows`, {
      rows: [{ id: 'a', input: { text: 'a' }, expected: 'wrong' }],
    });
    const baseline = await completed(f.api, run.data.id);
    assert.equal(baseline.experiment.status, 'completed');
    assert.equal(baseline.experiment.datasetVersion, 1);
    assert.equal(baseline.cases.length, 4);
    assert(baseline.cases.every((c: any) => Object.values(c.scores).every((score) => score === 1)));
    assert.equal(baseline.scorers[0].type, 'exact_match');
    const candidateId = (await f.api('/experiments', { ...config, name: 'candidate' })).data.id;
    await completed(f.api, candidateId);
    const comparison = (await f.api(`/compare?baseline=${run.data.id}&candidate=${candidateId}`))
      .data;
    assert.equal(comparison.comparable, false);
    assert(comparison.warning);
    assert.equal(comparison.rows.length, 4);
    const pinnedId = (await f.api('/experiments', { ...config, name: 'pinned', datasetVersion: 1 }))
      .data.id;
    const pinned = await completed(f.api, pinnedId);
    assert(pinned.cases.every((c: any) => Object.values(c.scores).every((score) => score === 1)));
  } finally {
    await f.close();
  }
});

test('missing scorer fields never pass and imported scores reject invalid numbers/row identities', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Missing fields',
        rows: [{ id: 'case', input: { a: 1 }, expected: { a: 1 } }],
      })
    ).data;
    const s = (
      await f.api('/scorers', {
        projectId: p.id,
        name: 'Missing',
        type: 'exact_match',
        config: { outputPath: 'missing', expectedPath: 'missing' },
      })
    ).data;
    const e = (
      await f.api('/experiments', {
        projectId: p.id,
        name: 'No accidental pass',
        datasetId: d.id,
        scorerIds: [s.id],
        task: { type: 'echo' },
      })
    ).data;
    const detail = await completed(f.api, e.id);
    assert(!Object.values(detail.cases[0].scores).some((v) => v === 1));
    for (const invalid of [
      { rowId: 'not-a-row', scores: { quality: 1 } },
      { rowId: 'case', scores: { quality: 2 } },
    ]) {
      const response = await f.api('/experiments/import', {
        projectId: p.id,
        name: 'invalid',
        datasetId: d.id,
        datasetVersion: 1,
        cases: [{ input: 'a', expected: 'a', output: 'a', ...invalid }],
      });
      assert(response.status >= 400 && response.status < 500);
    }
    const imported = await f.api('/experiments/import', {
      projectId: p.id,
      name: 'external',
      datasetId: d.id,
      datasetVersion: 1,
      cases: [
        {
          rowId: 'case',
          trial: 1,
          input: { a: 1 },
          expected: { a: 1 },
          output: 'x',
          scores: { quality: null },
          scoreErrors: { quality: 'Judge unavailable' },
          costUsd: null,
        },
      ],
    });
    assert(imported.status < 300);
    const importedDetail = (await f.api(`/experiments/${imported.data.id}`)).data;
    assert.equal(importedDetail.cases[0].scores.quality, null);
    assert.equal(importedDetail.cases[0].scoreErrors.quality, 'Judge unavailable');
    assert.equal(importedDetail.experiment.scores.quality, null);
  } finally {
    await f.close();
  }
});

test('auth, key revocation, origin checks, and cross-project references are enforced', async () => {
  const f = await fixture({ adminToken: 'integration-admin-token' });
  try {
    assert.equal((await f.api('/projects', undefined, 'GET', { authorization: '' })).status, 401);
    assert.equal(
      (
        await f.api('/projects', { name: 'cross-origin' }, 'POST', {
          origin: 'https://untrusted.example',
        })
      ).status,
      403,
    );
    const p = await project(f.api);
    const key = (await f.api('/keys', { name: 'test writer' })).data;
    assert.equal(typeof key.key, 'string');
    const headers = { authorization: `Bearer ${key.key}` };
    assert.equal((await f.api('/projects', undefined, 'GET', headers)).status, 200);
    assert.equal((await f.api('/keys', undefined, 'GET', headers)).status, 403);
    assert(!(await f.api('/keys')).data.some((k: any) => 'key' in k || 'hash' in k));
    await f.api(`/keys/${key.id}`, undefined, 'DELETE');
    assert.equal((await f.api('/projects', undefined, 'GET', headers)).status, 401);
    const other = await project(f.api);
    const d = (
      await f.api('/datasets', {
        projectId: other.id,
        name: 'Other',
        rows: [{ input: 'x', expected: 'x' }],
      })
    ).data;
    const result = await f.api('/experiments', {
      projectId: p.id,
      name: 'Cross project',
      datasetId: d.id,
      scorerIds: [],
      task: { type: 'echo' },
    });
    assert(result.status >= 400 && result.status < 500);
    assert.equal((await f.api('/does-not-exist')).status, 404);
  } finally {
    await f.close();
  }
});

test('prompt versions, playground outputs, annotation provenance, and provider availability are real', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const prompt = (
      await f.api('/prompts', {
        projectId: p.id,
        name: 'Greeting',
        system: 'Be concise',
        template: 'Hello {{input.name}}',
        model: 'test-model',
      })
    ).data;
    await f.api(`/prompts/${prompt.id}/versions`, {
      system: 'Be concise',
      template: 'Welcome {{input.name}}',
      model: 'test-model',
    });
    const detail = (await f.api(`/prompts/${prompt.id}`)).data;
    assert.equal(detail.versions.length, 2);
    assert(
      detail.versions.some((v: any) => v.version === 1 && v.template === 'Hello {{input.name}}'),
    );
    const output = await f.api('/playground', {
      projectId: p.id,
      task: { type: 'template', template: 'Hello {{input.name}}' },
      input: { name: 'Ada' },
    });
    assert.equal(output.data.output, 'Hello Ada');
    assert(output.data.traceId);
    const note = await f.api('/annotations', {
      projectId: p.id,
      targetType: 'trace',
      targetId: output.data.traceId,
      label: 'correct',
      comment: 'Reviewed',
      expected: 'Hello Ada',
    });
    assert(note.status < 300);
    assert.equal(
      (await f.api(`/traces/${output.data.traceId}`)).data.annotations[0].comment,
      'Reviewed',
    );
    const missingProvider = await f.api('/playground', {
      projectId: p.id,
      task: { type: 'openai', template: '{{input}}', model: 'test-model' },
      input: 'Hello',
    });
    assert(missingProvider.status >= 400);
    const missingVariable = await f.api('/playground', {
      projectId: p.id,
      task: { type: 'template', template: '{{input.unknown}}' },
      input: { x: 1 },
    });
    assert(missingVariable.status >= 400);
  } finally {
    await f.close();
  }
});

test('configured provider requests execute and token counts do not fabricate prices', async () => {
  let received: any;
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
      url: req.url,
    };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'Real test endpoint response' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address !== 'string');
  const f = await fixture({
    providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    providerApiKey: 'fixture-only-key',
  });
  try {
    const p = await project(f.api);
    const result = await f.api('/playground', {
      projectId: p.id,
      task: {
        type: 'openai',
        template: '{{input}}',
        system: 'Respond briefly',
        model: 'fixture-model',
      },
      input: 'Hello',
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.output, 'Real test endpoint response');
    assert.equal(result.data.inputTokens, 11);
    assert.equal(result.data.outputTokens, 7);
    assert.equal(result.data.costUsd, null);
    assert.equal(received.authorization, 'Bearer fixture-only-key');
    assert.equal(received.url, '/v1/chat/completions');
    const trace = (await f.api(`/traces/${result.data.traceId}`)).data;
    assert.equal(trace.trace.costUsd, null);
    assert(!JSON.stringify(trace).includes('fixture-only-key'));
  } finally {
    await f.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test('OTLP JSON preserves child-first parentage and retries without duplicate spans', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const traceId = '0123456789abcdef0123456789abcdef';
    const child = {
      traceId,
      spanId: 'bbbbbbbbbbbbbbbb',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      name: 'tool',
      kind: 3,
      startTimeUnixNano: '1791633600000000000',
      endTimeUnixNano: '1791633600010000000',
      attributes: [{ key: 'custom.field', value: { stringValue: 'preserved' } }],
      status: { code: 1 },
    };
    const root = {
      ...child,
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: '',
      name: 'agent',
      startTimeUnixNano: '1791633599990000000',
    };
    const payload = (spans: any[]) => ({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test-agent' } }] },
          scopeSpans: [{ scope: { name: 'integration' }, spans }],
        },
      ],
    });
    const headers = { 'x-mindtrust-project-id': p.id };
    assert.equal((await f.api('/v1/traces', payload([child]), 'POST', headers)).status, 200);
    assert.equal((await f.api('/v1/traces', payload([root, child]), 'POST', headers)).status, 200);
    const listed = (await f.api(`/traces?projectId=${p.id}`)).data;
    assert.equal(listed.total, 1);
    const detail = (await f.api(`/traces/${listed.items[0].id}`)).data;
    assert.equal(detail.spans.length, 2);
    const importedChild = detail.spans.find((s: any) => s.id === child.spanId);
    assert.equal(importedChild.parentId, root.spanId);
    assert(JSON.stringify(importedChild.metadata).includes('preserved'));
    assert.equal(
      new Date(importedChild.endTime).getTime() - new Date(importedChild.startTime).getTime(),
      10,
    );
  } finally {
    await f.close();
  }
});
