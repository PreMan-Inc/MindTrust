import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.ts';

async function fixture() {
  const runtime = createApp({ dbPath: ':memory:', seed: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const project = (await request('/api/projects', { name: 'Audit fixture' })).body;
  return {
    request,
    project,
    base,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
      await runtime.close();
    },
  };
}

test('audit: imported score values stay in the 0..1 contract', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const data = (
    await api.request('/api/datasets', {
      projectId: api.project.id,
      name: 'cases',
      rows: [{ id: 'r1', input: 'question', expected: 'answer' }],
    })
  ).body;
  for (const score of [-1, 2]) {
    const result = await api.request('/api/experiments/import', {
      projectId: api.project.id,
      name: 'invalid scores',
      datasetId: data.id,
      datasetVersion: 1,
      cases: [
        {
          rowId: 'r1',
          input: 'question',
          expected: 'answer',
          output: 'answer',
          scores: { quality: score },
        },
      ],
    });
    assert.equal(result.status, 400, `score ${score} must not be accepted as a quality score`);
  }
});

test('audit: imported cases that diverge from their claimed dataset revision cannot be deemed comparable', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const data = (
    await api.request('/api/datasets', {
      projectId: api.project.id,
      name: 'cases',
      rows: [{ id: 'r1', input: 'hard question', expected: 'verified answer' }],
    })
  ).body;
  const payload = {
    projectId: api.project.id,
    name: 'changed evidence',
    datasetId: data.id,
    datasetVersion: 1,
    cases: [
      {
        rowId: 'r1',
        input: 'different easy question',
        expected: 'different answer',
        output: 'different answer',
        scores: { quality: 1 },
      },
    ],
  };
  const result = await api.request('/api/experiments/import', payload);
  // Rejecting divergent imports also preserves this contract.
  if (result.status === 400) return;
  assert.equal(result.status, 201);
  const other = await api.request('/api/experiments/import', {
    ...payload,
    name: 'same changed evidence',
  });
  assert.equal(other.status, 201);
  const comparison = await api.request(
    `/api/compare?baseline=${result.body.id}&candidate=${other.body.id}`,
  );
  assert.equal(comparison.body.comparable, false);
  assert.match(comparison.body.warning || '', /dataset|revision|snapshot/i);
});

test('audit: no expected answer does not become a passing null equality', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const data = (
    await api.request('/api/datasets', {
      projectId: api.project.id,
      name: 'without ground truth',
      rows: [
        { id: 'r1', input: null },
        { id: 'r2', input: null, expected: null },
      ],
    })
  ).body;
  const scorer = (
    await api.request('/api/scorers', {
      projectId: api.project.id,
      name: 'Exact match',
      type: 'exact_match',
    })
  ).body;
  const created = (
    await api.request('/api/experiments', {
      projectId: api.project.id,
      name: 'missing expected',
      datasetId: data.id,
      scorerIds: [scorer.id],
      task: { type: 'echo' },
    })
  ).body;
  let detail: any;
  for (let i = 0; i < 100; i++) {
    detail = (await api.request(`/api/experiments/${created.id}`)).body;
    if (!['queued', 'running'].includes(detail.experiment.status)) break;
    await delay(5);
  }
  assert.notEqual(
    detail.cases[0].scores[scorer.id],
    1,
    'omitted expected is not evidence that a null output is correct',
  );
  assert.equal(
    detail.cases[1].scores[scorer.id],
    1,
    'an explicitly supplied null expectation remains meaningful',
  );
});

test('audit: trace time bounds compare instants rather than timestamp strings', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const result = await api.request('/api/traces', {
    projectId: api.project.id,
    traces: [
      {
        id: 'mixed-offsets',
        name: 'mixed offset timestamps',
        spans: [
          {
            id: 'late',
            name: 'late',
            startTime: '2026-10-10T10:00:00-08:00',
            endTime: '2026-10-10T10:01:00-08:00',
          },
          {
            id: 'early',
            name: 'early',
            startTime: '2026-10-10T11:00:00Z',
            endTime: '2026-10-10T11:01:00Z',
          },
        ],
      },
    ],
  });
  assert.equal(result.status, 201, result.body.error);
  const detail = (await api.request('/api/traces/mixed-offsets')).body;
  assert.equal(detail.trace.latencyMs, (7 * 60 + 1) * 60_000);
});

test('audit: OTLP span identity is scoped to its trace', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const spanId = '1234567890abcdef';
  const traceIds = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
  const result = await api.request(
    '/v1/traces',
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: traceIds.map((traceId) => ({
                traceId,
                spanId,
                name: 'same local span id',
                startTimeUnixNano: '1791658800000000000',
                endTimeUnixNano: '1791658801000000000',
              })),
            },
          ],
        },
      ],
    },
    { 'x-mindtrust-project-id': api.project.id },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.partialSuccess?.rejectedSpans || 0, 0);
  for (const traceId of traceIds)
    assert.equal((await api.request(`/api/traces/${traceId}`)).status, 200);
});

test('audit: local unauthenticated API rejects an untrusted Host without Origin', async (t) => {
  const api = await fixture();
  t.after(api.close);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      `${api.base}/api/projects`,
      { headers: { Host: 'untrusted-rebinding.example' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
