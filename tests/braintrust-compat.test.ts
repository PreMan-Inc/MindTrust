import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { Eval, initDataset, initLogger, login, wrapTraced } from 'braintrust';
import { createRequire } from 'node:module';
import { Store, HttpError } from '../server/store.ts';
import { mountBraintrustCompatibility } from '../server/braintrust-compat.ts';
import type { Dataset, EvalCase, Experiment, Project, Trace } from '../shared/types.ts';

const require = createRequire(import.meta.url);
test('contracts use the pinned official SDK release', () =>
  assert.equal(require('braintrust/package.json').version, '3.37.2'));

async function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    app = express();
  const allowed = randomUUID(),
    denied = randomUUID();
  for (const [id, name] of [
    [allowed, 'Allowed'],
    [denied, 'Denied'],
  ])
    store.put('project', { id, name, description: '', createdAt: new Date().toISOString() }, id);
  const token = (req: Request) => req.get('authorization')?.replace(/^Bearer /, '');
  function authenticate(req: Request) {
    if (!['admin-fixture', 'editor-fixture', 'viewer-fixture'].includes(token(req) ?? ''))
      throw new HttpError(401, 'Authentication required');
  }
  function requireProject(req: Request, id: string, permission: 'read' | 'write') {
    authenticate(req);
    if (token(req) !== 'admin-fixture' && id !== allowed)
      throw new HttpError(403, 'Project scope denied');
    if (token(req) === 'viewer-fixture' && permission === 'write')
      throw new HttpError(403, 'Write denied');
  }
  app.use(express.json({ limit: '5mb' }));
  mountBraintrustCompatibility(app, store, {
    authenticate,
    requireProject,
    workspaceId() {
      return 'legacy';
    },
    createProject(req, project) {
      authenticate(req);
      if (token(req) !== 'admin-fixture') throw new HttpError(403, 'Admin required');
      return store.createProject(project, 'legacy');
    },
    requireAdmin(req) {
      authenticate(req);
      if (token(req) !== 'admin-fixture') throw new HttpError(403, 'Admin required');
    },
    listProjects(req) {
      authenticate(req);
      return store
        .list<Project>('project')
        .filter((p) => token(req) === 'admin-fixture' || p.id === allowed);
    },
  });
  app.use(((error, _req, res, _next) =>
    res
      .status(error instanceof HttpError ? error.status : 500)
      .json({ error: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  async function request(path: string, body?: unknown, key = 'admin-fixture') {
    return fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const network: { path: string; status: number }[] = [],
    flushErrors: unknown[] = [];
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base, 'official SDK must never contact an external service');
    const response = await fetch(input, init);
    network.push({ path: url.pathname, status: response.status });
    return response;
  };
  const state = await login({
    appUrl: base,
    apiKey: 'admin-fixture',
    fetch: safeFetch,
    forceLogin: true,
    noExitFlush: true,
    onFlushError: (e) => flushErrors.push(e),
  });
  return { store, base, allowed, denied, request, state, network, flushErrors };
}

test('official initLogger and wrapTraced persist concurrent nested spans, errors, feedback and raw fields', async (t) => {
  const f = await fixture(t);
  const logger = initLogger({ projectName: 'Allowed', state: f.state, asyncFlush: false });
  const child = wrapTraced(async (input: string) => input.toUpperCase(), { name: 'child' });
  const ids = await Promise.all(
    ['one', 'two'].map((input) =>
      logger.traced(
        async (span) => {
          span.log({ input, metadata: { purpose: 'synthetic contract' } });
          const output = await child(input);
          span.log({ output });
          return span.id;
        },
        { name: input },
      ),
    ),
  );
  await assert.rejects(
    logger.traced(
      async () => {
        throw new Error('synthetic failure');
      },
      { name: 'failure' },
    ),
    /synthetic failure/,
  );
  logger.logFeedback({
    id: ids[0],
    scores: { human: 1 },
    comment: 'Reviewed synthetic output',
    metadata: { reviewer: 'test' },
  });
  await logger.flush();
  assert.deepEqual(f.flushErrors, []);
  const traces = f.store.list<Trace>('trace', f.allowed);
  assert.equal(traces.length, 3);
  for (const name of ['one', 'two']) {
    const trace = traces.find((r) => r.name === name)!;
    assert.ok(trace);
    const spans = f.store.traceDetail(trace.id).spans;
    assert.equal(spans.length, 2);
    const c = spans.find((s) => s.name === 'child')!,
      root = spans.find((s) => s.name === name)!;
    assert.equal(c.parentId, root.id);
    assert.equal(trace.output, name.toUpperCase());
  }
  assert.equal(traces.find((r) => r.name === 'failure')!.status, 'error');
  const exported = await (await f.request(`/v1/project_logs/${f.allowed}/fetch`)).json();
  assert.equal(exported.events.find((r: { id: string }) => r.id === ids[0]).scores.human, 1);
  assert.equal(f.store.list('annotation', f.allowed).length, 1);
  assert.ok(f.network.some((r) => r.path === '/logs3'));
  assert.ok(f.network.every((r) => r.status === 200));
});

test('official dataset workflow preserves missing expected, revisions, pagination, update and delete', async (t) => {
  const f = await fixture(t);
  const ds = initDataset({ project: 'Allowed', dataset: 'fixtures', state: f.state });
  ds.insert({
    id: 'first',
    input: null,
    expected: null,
    metadata: { nested: { old: 1 }, values: [1, 2] },
    tags: ['a'],
  });
  ds.insert({ id: 'second', input: 'missing expectation' });
  await ds.flush();
  assert.deepEqual(f.flushErrors, []);
  const snapshot = await ds.version();
  assert.ok(snapshot);
  const original = [];
  for await (const r of ds.fetch({ batchSize: 1 })) original.push(r);
  assert.equal(original.length, 2);
  assert.equal(original[0].expected, null);
  assert.equal(original[1].expected, undefined);
  const raw = (await (await f.request(`/v1/dataset/${await ds.id}/fetch`)).json()).events;
  assert.equal(Object.hasOwn(raw[1], 'expected'), false);
  ds.update({ id: 'first', metadata: { nested: { added: 2 }, values: [3] }, tags: ['b'] });
  ds.delete('second');
  await ds.flush();
  const current = await ds.fetchedData();
  assert.equal(current.length, 1);
  assert.deepEqual(current[0].metadata, { nested: { old: 1, added: 2 }, values: [3] });
  assert.deepEqual(current[0].tags, ['a', 'b']);
  const pinned = initDataset({ datasetId: await ds.id, version: snapshot, state: f.state });
  const previous = await pinned.fetchedData();
  assert.equal(previous.length, 2);
  assert.deepEqual(previous[0].metadata?.values, [1, 2]);
  const summary = await ds.summarize();
  assert.equal(summary.dataSummary?.totalRecords, 1);
  assert.deepEqual(f.flushErrors, []);
  assert.ok(f.network.every((r) => r.status === 200));
});

test('official Eval runs real local tasks and scorers against a pinned dataset into native cases', async (t) => {
  const f = await fixture(t);
  const ds = initDataset({ project: 'Allowed', dataset: 'evaluation-inputs', state: f.state });
  ds.insert({ id: 'a', input: 'a', expected: 'A' });
  ds.insert({ id: 'b', input: 'b', expected: 'B' });
  await ds.flush();
  const dataVersion = await ds.version();
  let active = 0,
    maxActive = 0;
  const result = await Eval(
    'Allowed',
    {
      experimentName: 'upper-case',
      state: f.state,
      data: ds,
      maxConcurrency: 2,
      task: async (input) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return input.toUpperCase();
      },
      scores: [
        function Exact({ output, expected }: { output: string; expected?: string }) {
          return output === expected ? 1 : 0;
        },
      ],
    },
    {
      progress: { start() {}, stop() {}, increment() {} },
      reporter: {
        name: 'silent',
        reportEval() {},
        reportRun() {
          return true;
        },
      },
    },
  );
  assert.deepEqual(f.flushErrors, []);
  const experiment = f.store.list<Experiment>('experiment', f.allowed)[0];
  assert.equal(experiment.executionSource, 'sdk-import');
  assert.equal(experiment.task.type, 'external');
  assert.equal(experiment.status, 'completed');
  assert.equal(experiment.completedCases, 2);
  assert.equal(String(experiment.datasetVersion).padStart(20, '0'), dataVersion);
  assert.equal(
    result.summary.scores.Exact?.score,
    1,
    JSON.stringify({ summary: result.summary, native: experiment.scores }),
  );
  assert.equal(maxActive, 2);
  const cases = f.store.list<EvalCase>('case', f.allowed, experiment.id);
  assert.deepEqual(cases.map((c) => c.output).sort(), ['A', 'B']);
  assert.deepEqual(cases.map((c) => c.rowId).sort(), ['a', 'b']);
  ds.update({ id: 'a', expected: 'changed' });
  await ds.flush();
  assert.equal(
    f.store.experimentSnapshot(experiment.id).rows.find((r) => r.id === 'a')!.expected,
    'A',
  );
  assert.ok(
    f.network.every(
      (r) => r.status === 200 || (r.path === '/api/base_experiment/get_id' && r.status === 400),
    ),
  );
});

test('official Eval compares a named baseline using matched pinned dataset cases', async (t) => {
  const f = await fixture(t);
  const ds = initDataset({ project: 'Allowed', dataset: 'comparison-inputs', state: f.state });
  ds.insert({ id: 'a', input: 0, expected: 1 });
  ds.insert({ id: 'b', input: 1, expected: 1 });
  await ds.flush();
  const run = (name: string, candidate = false) =>
    Eval(
      'Allowed',
      {
        experimentName: name,
        state: f.state,
        data: ds,
        ...(candidate ? { baseExperimentName: 'comparison-baseline' } : {}),
        task: async (input: number) => (candidate ? 1 : input),
        scores: [
          function Quality({ output }: { output: number }) {
            return output;
          },
        ],
      },
      {
        progress: { start() {}, stop() {}, increment() {} },
        reporter: {
          name: 'silent',
          reportEval() {},
          reportRun() {
            return true;
          },
        },
      },
    );
  await run('comparison-baseline');
  const result = await run('comparison-candidate', true);
  assert.deepEqual(result.summary.scores.Quality, {
    name: 'Quality',
    score: 1,
    diff: 0.5,
    improvements: 1,
    regressions: 0,
  });
  assert.equal(
    f.store
      .list<Experiment>('experiment', f.allowed)
      .find((e) => e.name === 'comparison-candidate')!.status,
    'completed',
  );
  assert.deepEqual(f.flushErrors, []);
  assert(!f.network.some((r) => r.status === 501));
});

test('comparison summaries use aligned valid scores and latency; incomplete or incompatible runs fail explicitly', async (t) => {
  const f = await fixture(t);
  const registration = await (
    await f.request('/api/dataset/register', {
      project_id: f.allowed,
      dataset_name: 'comparison-contract',
    })
  ).json();
  const datasetId = registration.dataset.id;
  assert.equal(
    (
      await f.request('/logs3', {
        rows: ['a', 'b', 'c'].map((id) => ({ id, dataset_id: datasetId, input: id, expected: id })),
        api_version: 2,
      })
    ).status,
    200,
  );
  const version = f.store.require<Dataset>('dataset', datasetId).version;
  const createRun = async (
    name: string,
    values: { quality?: number | null; nullable?: number | null; end?: number; error?: string }[],
    pinnedVersion = version,
  ) => {
    const result = await f.request('/api/experiment/register', {
      project_id: f.allowed,
      experiment_name: name,
      dataset_id: datasetId,
      dataset_version: String(pinnedVersion),
    });
    assert.equal(result.status, 200);
    const id = (await result.json()).experiment.id;
    if (values.length) {
      const write = await f.request('/logs3', {
        api_version: 2,
        rows: values.map((value, index) => ({
          id: `${name}-${index}`,
          experiment_id: id,
          span_id: `${name}-span-${index}`,
          root_span_id: `${name}-span-${index}`,
          dataset_record_id: ['a', 'b', 'c'][index],
          input: ['a', 'b', 'c'][index],
          expected: ['a', 'b', 'c'][index],
          output: index,
          scores: { quality: value.quality ?? null, nullable: value.nullable ?? null },
          metrics: { start: 1000, ...(value.end === undefined ? {} : { end: 1000 + value.end }) },
          ...(value.error ? { error: value.error } : {}),
        })),
      });
      assert.equal(write.status, 200, await write.text());
    }
    return id;
  };
  const baseline = await createRun('aligned-baseline', [
    { quality: 0, nullable: 1, end: 1 },
    { quality: 0.5, nullable: null, end: 2 },
    { quality: 1, nullable: 0, end: 3 },
  ]);
  const candidate = await createRun('aligned-candidate', [
    { quality: 1, nullable: 0, end: 0.5 },
    { quality: 0.25, nullable: 1, end: 3 },
    { quality: 1, nullable: null, end: 3 },
  ]);
  const compare = (id: string, base = baseline) =>
    f.request(
      `/v1/experiment/${id}/summarize?summarize_scores=true&comparison_experiment_id=${base}`,
    );
  const response = await compare(candidate);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.deepEqual(summary.scores.quality, {
    name: 'quality',
    score: 0.75,
    diff: 0.25,
    improvements: 1,
    regressions: 1,
  });
  assert.deepEqual(summary.scores.nullable, {
    name: 'nullable',
    score: 0,
    diff: -1,
    improvements: 0,
    regressions: 1,
  });
  assert(Math.abs(summary.metrics.latency.metric - 6.5 / 3) < 1e-10);
  assert(Math.abs(summary.metrics.latency.diff - 0.5 / 3) < 1e-10);
  assert.equal(summary.metrics.latency.improvements, 1);
  assert.equal(summary.metrics.latency.regressions, 1);
  assert.equal(f.store.require<Experiment>('experiment', candidate).status, 'completed');
  const missing = await createRun('missing-case', [
    { quality: 1, end: 1 },
    { quality: 1, end: 1 },
  ]);
  assert.equal((await compare(missing)).status, 409);
  assert.equal(f.store.require<Experiment>('experiment', missing).status, 'running');
  const unfinished = await createRun('unfinished-case', [
    { quality: 1, end: 1 },
    { quality: 1, end: 1 },
    { quality: 1 },
  ]);
  assert.equal((await compare(unfinished)).status, 409);
  const failed = await createRun(
    'failed-cases',
    ['a', 'b', 'c'].map(() => ({ quality: 1, end: 1, error: 'Synthetic task failure' })),
  );
  const failedSummary = await compare(failed);
  assert.equal(failedSummary.status, 200);
  assert.deepEqual(await failedSummary.json(), { scores: {}, metrics: {} });
  assert.equal(f.store.require<Experiment>('experiment', failed).status, 'failed');
  assert.equal(
    (
      await f.request('/logs3', {
        api_version: 2,
        rows: [
          {
            id: 'a',
            dataset_id: datasetId,
            input: 'a',
            expected: 'a',
            metadata: { updated: true },
          },
        ],
      })
    ).status,
    200,
  );
  const changed = await createRun(
    'changed-revision',
    [
      { quality: 1, end: 1 },
      { quality: 1, end: 1 },
      { quality: 1, end: 1 },
    ],
    f.store.require<Dataset>('dataset', datasetId).version,
  );
  assert.equal((await compare(changed)).status, 409);
  assert.equal(
    (
      await f.request(
        `/v1/experiment/${candidate}/summarize?comparison_experiment_id=${baseline}`,
        undefined,
        'invalid',
      )
    ).status,
    401,
  );
});

test('writes are atomic/idempotent; merge paths replace objects; unsupported controls fail explicitly', async (t) => {
  const f = await fixture(t);
  const registration = await f.request('/api/dataset/register', {
    project_id: f.allowed,
    dataset_name: 'merge',
  });
  const id = (await registration.json()).dataset.id;
  const insert = {
    rows: [
      {
        id: 'r',
        dataset_id: id,
        input: { a: 1 },
        expected: false,
        metadata: { nested: { old: true }, untouched: 1 },
        extra_export_column: { preserved: true },
      },
    ],
    api_version: 2,
  };
  assert.equal((await f.request('/logs3', insert)).status, 200);
  const before = f.store.require<Dataset>('dataset', id).version;
  assert.equal((await f.request('/logs3', insert)).status, 200);
  assert.equal(f.store.require<Dataset>('dataset', id).version, before);
  assert.equal(
    (
      await f.request('/logs3', {
        rows: [
          {
            id: 'r',
            dataset_id: id,
            metadata: { nested: { fresh: true } },
            _is_merge: true,
            _merge_paths: [['metadata', 'nested']],
          },
        ],
      })
    ).status,
    200,
  );
  const exported = (await (await f.request(`/v1/dataset/${id}/fetch`)).json()).events[0];
  assert.deepEqual(exported.metadata, { nested: { fresh: true }, untouched: 1 });
  assert.deepEqual(exported.extra_export_column, { preserved: true });
  const failed = await f.request('/logs3', {
    rows: [
      { id: 'accepted-only-if-atomicity-fails', dataset_id: id, input: 1 },
      { id: 'bad', dataset_id: id, input: 2, _array_delete: [['tags', 0]] },
    ],
  });
  assert.equal(failed.status, 501);
  assert.equal(f.store.datasetRows(id).length, 1);
  const malicious = await f.request(
    '/logs3',
    JSON.parse(
      `{"rows":[{"id":"bad","dataset_id":"${id}","input":{},"metadata":{"__proto__":{"polluted":true}}}]}`,
    ),
  );
  assert.equal(malicious.status, 400);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(
    (await f.request('/btql', { query: { select: [{ op: 'star' }], from: {}, where: 'true' } }))
      .status,
    501,
  );
});

test('legacy root paths authenticate and mixed-project batches cannot bypass scoped permissions', async (t) => {
  const f = await fixture(t);
  for (const [path, body] of [
    ['/logs3', { rows: [] }],
    ['/btql', {}],
    ['/api/apikey/login', {}],
  ] as const)
    assert.equal((await f.request(path, body, 'invalid')).status, 401);
  for (const path of [
    '/version',
    '/ping',
    '/dataset-summary?dataset_id=anything',
    '/experiment-comparison2?experiment_id=anything',
  ])
    assert.equal((await f.request(path, undefined, 'invalid')).status, 401);
  const list = await (await f.request('/api/project', undefined, 'editor-fixture')).json();
  assert.deepEqual(
    list.objects.map((p: { id: string }) => p.id),
    [f.allowed],
  );
  const logs = {
    rows: [
      { id: 'allowed-row', project_id: f.allowed, log_id: 'g', input: 'safe' },
      { id: 'denied-row', project_id: f.denied, log_id: 'g', input: 'forbidden' },
    ],
  };
  assert.equal((await f.request('/logs3', logs, 'editor-fixture')).status, 403);
  assert.equal(f.store.list('trace').length, 0);
  assert.equal((await f.request('/logs3', { rows: [logs.rows[0]] }, 'viewer-fixture')).status, 403);
  assert.equal(
    (await f.request('/v1/project_logs/' + f.denied + '/fetch', undefined, 'editor-fixture'))
      .status,
    403,
  );
});

test('ingestion does not rewrite unrelated historical traces and cursor reads reject concurrent changes', async (t) => {
  const f = await fixture(t);
  const row = (id: string) => ({
    id,
    project_id: f.allowed,
    log_id: 'g',
    span_id: id,
    root_span_id: id,
    input: id,
    metrics: { start: 1, end: 2 },
  });
  assert.equal((await f.request('/logs3', { rows: [row('first')] })).status, 200);
  const before = f.store.list<Trace>('trace', f.allowed)[0];
  f.store.db.exec(`CREATE TEMP TABLE rewritten(kind TEXT,id TEXT);
    CREATE TEMP TRIGGER observed_record_update AFTER UPDATE ON records BEGIN INSERT INTO rewritten VALUES(new.kind,new.id); END;
    CREATE TEMP TRIGGER observed_record_delete AFTER DELETE ON records BEGIN INSERT INTO rewritten VALUES(old.kind,old.id); END;`);
  assert.equal((await f.request('/logs3', { rows: [row('second')] })).status, 200);
  assert.deepEqual(
    f.store.db.prepare('SELECT * FROM rewritten').all(),
    [],
    'new roots must not rewrite historical traces or spans',
  );
  assert.deepEqual(f.store.require<Trace>('trace', before.id), before);
  const firstPage = await (await f.request(`/v1/project_logs/${f.allowed}/fetch?limit=1`)).json();
  assert.ok(firstPage.cursor);
  assert.equal((await f.request('/logs3', { rows: [row('third')] })).status, 200);
  assert.equal(
    (await f.request(`/v1/project_logs/${f.allowed}/fetch?limit=1&cursor=${firstPage.cursor}`))
      .status,
    409,
  );
  assert.equal(
    (await f.request('/logs3', { rows: [{ ...row('first'), _object_delete: true }] })).status,
    501,
  );
  assert.equal(
    f.store.traceDetail(before.id).spans.length,
    1,
    'unsupported deletion must not leave a partially deleted trace',
  );
});

test('raw-only dataset edits are versioned and REST feedback preserves audit records', async (t) => {
  const f = await fixture(t);
  const id = (
    await (await f.request('/v1/dataset', { project_id: f.allowed, name: 'raw revisions' })).json()
  ).id;
  await f.request(`/v1/dataset/${id}/insert`, {
    events: [{ id: 'r', input: 1, extra: { source: 'first' } }],
  });
  const pinned = f.store.require<Dataset>('dataset', id).version;
  await f.request(`/v1/dataset/${id}/insert`, {
    events: [{ id: 'r', _is_merge: true, extra: { source: 'second' } }],
  });
  assert.equal(f.store.require<Dataset>('dataset', id).version, pinned + 1);
  const old = await (await f.request(`/v1/dataset/${id}/fetch?version=${pinned}`)).json();
  const current = await (await f.request(`/v1/dataset/${id}/fetch`)).json();
  assert.equal(old.events[0].extra.source, 'first');
  assert.equal(current.events[0].extra.source, 'second');
  const log = {
    id: 'reviewed',
    project_id: f.allowed,
    log_id: 'g',
    input: 'synthetic',
    output: 'answer',
  };
  await f.request('/logs3', { rows: [log] });
  assert.equal(
    (
      await f.request(`/v1/project_logs/${f.allowed}/feedback`, {
        feedback: [
          {
            id: 'reviewed',
            scores: { human: 0.75 },
            comment: 'Reviewed',
            metadata: { reviewer: 'contract' },
          },
        ],
      })
    ).status,
    200,
  );
  const raw = await (await f.request(`/v1/project_logs/${f.allowed}/fetch`)).json();
  assert.equal(raw.events.find((r: { id: string }) => r.id === 'reviewed').scores.human, 0.75);
  assert.equal(f.store.list('annotation', f.allowed).length, 1);
  assert.equal(
    (
      await f.request('/logs3', {
        rows: [
          {
            id: 'phantom',
            project_id: f.allowed,
            scores: { human: 1 },
            _is_merge: true,
            _audit_source: 'external',
          },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/logs3', {
        rows: [
          {
            id: 'attachment',
            project_id: f.allowed,
            input: { type: 'braintrust_attachment', key: 'unavailable-file' },
          },
        ],
      })
    ).status,
    501,
  );
});

test('official inline Eval distinguishes equal inputs with different ground truth while retaining repeated trials', async (t) => {
  const f = await fixture(t);
  const result = await Eval(
    'Allowed',
    {
      experimentName: 'distinct-expectations',
      state: f.state,
      data: [
        { input: 'same', expected: 'one' },
        { input: 'same', expected: 'two' },
      ],
      task: (input) => input,
      trialCount: 2,
      maxConcurrency: 2,
      scores: [
        function Exact({ output, expected }: { output: string; expected?: string }) {
          return output === expected ? 1 : 0;
        },
      ],
    },
    {
      progress: { start() {}, stop() {}, increment() {} },
      reporter: {
        name: 'silent',
        reportEval() {},
        reportRun() {
          return true;
        },
      },
    },
  );
  assert.deepEqual(f.flushErrors, []);
  const e = f.store.list<Experiment>('experiment', f.allowed)[0];
  const snapshot = f.store.experimentSnapshot(e.id);
  assert.deepEqual(snapshot.rows.map((r) => r.expected).sort(), ['one', 'two']);
  const cases = f.store.list<EvalCase>('case', f.allowed, e.id);
  assert.equal(cases.length, 4);
  for (const expected of ['one', 'two']) {
    const group = cases.filter((c) => c.expected === expected);
    assert.deepEqual(group.map((c) => c.trial).sort(), [1, 2]);
    assert.equal(new Set(group.map((c) => c.rowId)).size, 1);
    assert.equal(snapshot.rows.find((r) => r.id === group[0].rowId)!.expected, expected);
  }
  assert.equal(result.summary.scores.Exact.score, 0);
});

test('datasets can create a project for administrators and trial overflow rejects the complete batch', async (t) => {
  const f = await fixture(t);
  const ds = initDataset({ project: 'New SDK project', dataset: 'first dataset', state: f.state });
  ds.insert({ id: 'first', input: 'input' });
  await ds.flush();
  assert.deepEqual(f.flushErrors, []);
  assert.equal((await ds.fetchedData()).length, 1);
  const created = await (
    await f.request('/v1/experiment', { project_id: f.allowed, name: 'trial overflow' })
  ).json();
  const events = Array.from({ length: 11 }, (_, i) => ({
    id: `case-${i}`,
    input: 'same',
    expected: 'same',
    span_id: `span-${i}`,
    root_span_id: `span-${i}`,
    metrics: { start: 1, end: 2 },
  }));
  assert.equal((await f.request(`/v1/experiment/${created.id}/insert`, { events })).status, 501);
  assert.equal(f.store.list('case', f.allowed, created.id).length, 0);
  assert.equal(
    (await (await f.request(`/v1/experiment/${created.id}/fetch`)).json()).events.length,
    0,
  );
});

test('full trace replacement clears derived fields and rejects ambiguous row identity changes', async (t) => {
  const f = await fixture(t);
  const row = {
    id: 'root',
    project_id: f.allowed,
    span_id: 'root-span',
    root_span_id: 'root-span',
    metadata: { model: 'old-model' },
    input: 'old',
    output: 'old',
    metrics: { start: 1, end: 2 },
  };
  assert.equal((await f.request('/logs3', { rows: [row] })).status, 200);
  const traceId = f.store.list<Trace>('trace', f.allowed)[0].id;
  assert.equal(f.store.require<Trace>('trace', traceId).model, 'old-model');
  assert.equal(
    (
      await f.request('/logs3', {
        rows: [{ id: row.id, project_id: f.allowed, input: 'new', metrics: { start: 3, end: 4 } }],
      })
    ).status,
    200,
  );
  const updated = f.store.require<Trace>('trace', traceId);
  assert.equal(updated.model, null);
  assert.equal(updated.output, null);
  assert.equal((await f.request('/logs3', { rows: [{ ...row, id: 'alias' }] })).status, 409);
  assert.equal(f.store.traceDetail(traceId).spans.length, 1);
  assert.equal(
    (
      await f.request('/logs3', {
        rows: [
          {
            id: 'root',
            project_id: f.allowed,
            comment: { text: 'wrong kind' },
            origin: { id: 'root' },
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(f.store.list('annotation', f.allowed).length, 0);
});
