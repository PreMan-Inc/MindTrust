import express, { type ErrorRequestHandler, type Request } from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  Annotation,
  ApiKey,
  Comparison,
  ComparisonRow,
  Dataset,
  DatasetRow,
  EvalCase,
  Experiment,
  Json,
  Overview,
  Project,
  Prompt,
  Scorer,
  ServerInfo,
  Trace,
} from '../shared/types.ts';
import {
  EvaluationQueue,
  aggregateExperiment,
  executeTask,
  stableJson,
  taskTrace,
} from './evaluation.ts';
import { seedDemo } from './seed-data.ts';
import { HttpError, Store } from './store.ts';
import { ingestOtlp, writeTrace } from './traces.ts';
import {
  idSchema,
  importCaseSchema,
  jsonSchema,
  nameSchema,
  parse,
  positiveQuery,
  rowSchema,
  scorerSchema,
  taskSchema,
  traceSchema,
} from './validation.ts';

export interface AppOptions {
  dbPath?: string;
  seed?: boolean;
  adminToken?: string;
  providerBaseUrl?: string;
  providerApiKey?: string;
}
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equalSecret(actual: string, expected: string) {
  return timingSafeEqual(Buffer.from(hash(actual)), Buffer.from(hash(expected)));
}
function keyOf(req: Request) {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}
function parameter(req: Request, name: string) {
  const value = req.params[name];
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid path parameter');
  return value;
}
function projectQuery(req: Request, store: Store) {
  const id = parse(idSchema, req.query.projectId);
  store.project(id);
  return id;
}
function datasetVersion(req: Request) {
  return req.query.version === undefined ? undefined : positiveQuery(req.query.version, 1);
}
function rowsFrom(input: z.infer<typeof rowSchema>[]): DatasetRow[] {
  const rows = input.map((r) => ({
    id: r.id ?? r._id ?? randomUUID(),
    input: r.input,
    expected: r.expected ?? null,
    hasExpected: Object.hasOwn(r, 'expected') && r.hasExpected !== false,
    metadata: r.metadata ?? {},
    tags: r.tags ?? [],
  }));
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new HttpError(400, 'Duplicate row IDs in request');
  return rows;
}
function requiredProjectResource<T extends { projectId: string }>(
  store: Store,
  kind: 'dataset' | 'scorer' | 'trace' | 'case',
  id: string,
  projectId: string,
): T {
  const resource = store.require<T>(kind, id);
  if (resource.projectId !== projectId)
    throw new HttpError(400, `${kind} belongs to another project`);
  return resource;
}
function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function createApp(options: AppOptions = {}) {
  const dbPath = options.dbPath ?? resolve('data/mindtrust.sqlite');
  const store = new Store(dbPath);
  const adminToken = options.adminToken ?? '';
  const provider = {
    baseUrl: options.providerBaseUrl ?? 'https://api.openai.com/v1',
    apiKey: options.providerApiKey,
  };
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
    if (
      !['https:', 'http:'].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    )
      throw new Error();
  } catch {
    store.close();
    throw new Error(
      'Provider base URL must be an HTTP(S) URL without credentials, query, or fragment',
    );
  }
  if (options.seed !== false) seedDemo(store);
  const queue = new EvaluationQueue(store, provider);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api') || req.path.startsWith('/v1'))
      res.setHeader('Cache-Control', 'no-store');
    // Reject DNS-rebinding requests before serving any unauthenticated local data.
    // Authenticated deployments still require their token and browser origin allowlist.
    if (!adminToken && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname))
      return res.status(403).json({ error: 'Host is not allowed in local development mode' });
    const origin = req.get('origin');
    if (origin) {
      const port = req.socket.localPort ?? 4310;
      const origins = new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://[::1]:${port}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
        'http://127.0.0.1:5190',
        'http://localhost:5190',
        ...(process.env.MINDTRUST_ALLOWED_ORIGINS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ]);
      if (!origins.has(origin))
        return res.status(403).json({ error: 'Browser origin is not allowed' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Mindtrust-Project-Id',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '5mb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(['/api', '/v1'], (req, res, next) => {
    if (!adminToken) return next();
    const token = keyOf(req);
    if (token && equalSecret(token, adminToken)) return next();
    if (token && store.db.prepare('SELECT id FROM api_keys WHERE hash=?').get(hash(token)))
      return next();
    res.status(401).json({ error: 'A valid Bearer token is required' });
  });
  const admin = (req: Request) => {
    if (adminToken && !equalSecret(keyOf(req), adminToken))
      throw new HttpError(403, 'The server admin token is required to manage API keys');
  };

  app.get('/api/info', (_req, res) => {
    const info: ServerInfo = {
      version: '0.1.0',
      authEnabled: !!adminToken,
      providerConfigured: !!provider.apiKey,
      providerBaseUrl: baseUrl.origin + baseUrl.pathname,
      storage: 'SQLite',
      demoSeeded: store.setting('demoSeeded') === 'true',
    };
    res.json(info);
  });
  app.get('/api/projects', (_req, res) => res.json(store.list<Project>('project')));
  app.post('/api/projects', (req, res) => {
    const body = parse(
      z.object({ name: nameSchema, description: z.string().max(10000).optional() }),
      req.body,
    );
    const p: Project = {
      id: randomUUID(),
      name: body.name,
      description: body.description ?? '',
      createdAt: now(),
    };
    store.put('project', p, p.id);
    res.status(201).json(p);
  });
  app.get('/api/overview', (req, res) => {
    const projectId = projectQuery(req, store),
      traces = store.list<Trace>('trace', projectId),
      experiments = store.list<Experiment>('experiment', projectId),
      errors = traces.filter((t) => t.status === 'error');
    const days = new Map<string, Overview['series'][number]>(),
      models = new Map<string, Overview['models'][number]>();
    for (const trace of traces) {
      const date = trace.startTime.slice(0, 10);
      const day = days.get(date) ?? { date, traces: 0, errors: 0, costUsd: 0, tokens: 0 };
      day.traces++;
      day.errors += trace.status === 'error' ? 1 : 0;
      day.costUsd += trace.costUsd ?? 0;
      day.tokens += trace.inputTokens + trace.outputTokens;
      days.set(date, day);
      const model = trace.model ?? 'Unspecified';
      const m = models.get(model) ?? { model, traces: 0, tokens: 0, costUsd: 0 };
      m.traces++;
      m.tokens += trace.inputTokens + trace.outputTokens;
      m.costUsd += trace.costUsd ?? 0;
      models.set(model, m);
    }
    const overview: Overview = {
      traceCount: traces.length,
      errorCount: errors.length,
      errorRate: traces.length ? errors.length / traces.length : 0,
      p50LatencyMs: percentile(
        traces.map((t) => t.latencyMs),
        0.5,
      ),
      p95LatencyMs: percentile(
        traces.map((t) => t.latencyMs),
        0.95,
      ),
      totalTokens: traces.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0),
      knownCostUsd: traces.reduce((n, t) => n + (t.costUsd ?? 0), 0),
      unknownCostCount: traces.filter((t) => t.costUsd === null).length,
      datasetCount: store.list<Dataset>('dataset', projectId).length,
      experimentCount: experiments.length,
      series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: [...models.values()].sort((a, b) => b.traces - a.traces),
      recentTraces: traces.sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 8),
      recentExperiments: experiments
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5),
    };
    res.json(overview);
  });
  app.get('/api/traces', (req, res) => {
    const projectId = projectQuery(req, store),
      limit = positiveQuery(req.query.limit, 50, 200),
      offset = positiveQuery(req.query.offset, 0);
    if (req.query.status !== undefined && !['ok', 'error'].includes(String(req.query.status)))
      throw new HttpError(400, 'Status must be ok or error');
    if (req.query.search !== undefined && typeof req.query.search !== 'string')
      throw new HttpError(400, 'Invalid search query');
    const search = String(req.query.search ?? '').toLocaleLowerCase();
    const traces = store
      .list<Trace>('trace', projectId)
      .filter(
        (t) =>
          (!req.query.status || t.status === req.query.status) &&
          (!search ||
            JSON.stringify([t.name, t.input, t.output, t.metadata, t.tags])
              .toLocaleLowerCase()
              .includes(search)),
      )
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
    res.json({ items: traces.slice(offset, offset + limit), total: traces.length });
  });
  app.post('/api/traces', (req, res) => {
    const body = parse(
      z.object({ projectId: idSchema, traces: z.array(traceSchema).min(1).max(1000) }),
      req.body,
    );
    store.project(body.projectId);
    const ids = store.transaction(() =>
      body.traces.map((trace) => writeTrace(store, body.projectId, trace).id),
    );
    res.status(201).json({ ids });
  });
  app.get('/api/traces/export', (req, res) => {
    const projectId = projectQuery(req, store);
    res
      .attachment('mindtrust-traces.json')
      .json(store.list<Trace>('trace', projectId).map((t) => store.traceDetail(t.id)));
  });
  app.get('/api/traces/:id', (req, res) => res.json(store.traceDetail(parameter(req, 'id'))));
  app.post('/v1/traces', (req, res) => {
    if (!req.is('application/json'))
      throw new HttpError(415, 'This endpoint supports OTLP/HTTP JSON only');
    res.json(ingestOtlp(store, req.body, req.get('x-mindtrust-project-id')));
  });

  app.get('/api/annotations', (req, res) =>
    res.json(store.list<Annotation>('annotation', projectQuery(req, store))),
  );
  app.post('/api/annotations', (req, res) => {
    const body = parse(
      z.object({
        projectId: idSchema,
        targetType: z.enum(['trace', 'case']),
        targetId: idSchema,
        label: z.enum(['correct', 'incorrect', 'needs_review']),
        comment: z.string().max(10000).optional(),
        expected: jsonSchema.optional(),
      }),
      req.body,
    );
    store.project(body.projectId);
    if (body.targetType === 'trace')
      requiredProjectResource<Trace>(store, 'trace', body.targetId, body.projectId);
    else {
      const c = store.require<EvalCase>('case', body.targetId);
      const e = store.require<Experiment>('experiment', c.experimentId);
      if (e.projectId !== body.projectId)
        throw new HttpError(400, 'Case belongs to another project');
    }
    const value: Annotation = {
      ...body,
      id: randomUUID(),
      comment: body.comment ?? '',
      expected: body.expected ?? null,
      createdAt: now(),
    };
    store.put('annotation', value, body.projectId, body.targetId);
    res.status(201).json(value);
  });

  app.get('/api/datasets', (req, res) =>
    res.json(store.list<Dataset>('dataset', projectQuery(req, store))),
  );
  app.post('/api/datasets', (req, res) => {
    const body = parse(
      z.object({
        projectId: idSchema,
        name: nameSchema,
        description: z.string().max(10000).optional(),
        rows: z.array(rowSchema).max(10000).optional(),
      }),
      req.body,
    );
    store.project(body.projectId);
    const rows = rowsFrom(body.rows ?? []);
    const dataset: Dataset = {
      id: randomUUID(),
      projectId: body.projectId,
      name: body.name,
      description: body.description ?? '',
      version: 1,
      rowCount: rows.length,
      updatedAt: now(),
    };
    store.transaction(() => store.saveDatasetSnapshot(dataset, rows));
    res.status(201).json(dataset);
  });
  app.get('/api/datasets/:id/export', (req, res) => {
    res
      .attachment('mindtrust-dataset.json')
      .json(store.datasetRows(parameter(req, 'id'), datasetVersion(req)));
  });
  app.get('/api/datasets/:id', (req, res) =>
    res.json(store.datasetDetail(parameter(req, 'id'), datasetVersion(req))),
  );
  const writeRows = (req: Request) => {
    const id = parameter(req, 'id'),
      body = parse(z.object({ rows: z.array(rowSchema).max(10000) }), req.body);
    const incoming = rowsFrom(body.rows);
    return store.transaction(() => {
      const dataset = store.require<Dataset>('dataset', id),
        rows = store.datasetRows(id),
        byId = new Map(rows.map((r) => [r.id, r]));
      for (const row of incoming) byId.set(row.id, row);
      if (byId.size > 100000) throw new HttpError(413, 'Dataset cannot exceed 100000 rows');
      const updated = {
        ...dataset,
        version: dataset.version + 1,
        rowCount: byId.size,
        updatedAt: now(),
      };
      store.saveDatasetSnapshot(updated, [...byId.values()]);
      return store.datasetDetail(id);
    });
  };
  app.post('/api/datasets/:id/rows', (req, res) => res.json(writeRows(req)));
  app.post('/api/datasets/:id/import', (req, res) => res.json(writeRows(req)));
  app.delete('/api/datasets/:id/rows/:rowId', (req, res) => {
    const id = parameter(req, 'id'),
      rowId = parameter(req, 'rowId');
    const result = store.transaction(() => {
      const dataset = store.require<Dataset>('dataset', id),
        rows = store.datasetRows(id);
      if (!rows.some((r) => r.id === rowId)) throw new HttpError(404, 'Dataset row not found');
      const remaining = rows.filter((r) => r.id !== rowId);
      store.saveDatasetSnapshot(
        { ...dataset, version: dataset.version + 1, rowCount: remaining.length, updatedAt: now() },
        remaining,
      );
      return store.datasetDetail(id);
    });
    res.json(result);
  });

  app.get('/api/scorers', (req, res) =>
    res.json(store.list<Scorer>('scorer', projectQuery(req, store))),
  );
  app.post('/api/scorers', (req, res) => {
    const body = parse(scorerSchema, req.body);
    store.project(body.projectId);
    for (const key of ['outputPath', 'expectedPath']) {
      const path = body.config?.[key];
      if (
        path !== undefined &&
        (typeof path !== 'string' ||
          path.split('.').some((p) => !p || ['__proto__', 'prototype', 'constructor'].includes(p)))
      )
        throw new HttpError(400, `${key} must be a safe dot path`);
    }
    const scorer: Scorer = {
      ...body,
      id: randomUUID(),
      config: body.config ?? {},
      description: body.description ?? '',
      createdAt: now(),
    };
    store.put('scorer', scorer, body.projectId);
    res.status(201).json(scorer);
  });

  app.get('/api/experiments', (req, res) =>
    res.json(store.list<Experiment>('experiment', projectQuery(req, store))),
  );
  app.post('/api/experiments', (req, res) => {
    const body = parse(
      z.object({
        projectId: idSchema,
        name: nameSchema,
        description: z.string().max(10000).optional(),
        datasetId: idSchema,
        datasetVersion: z.number().int().min(1).optional(),
        scorerIds: z.array(idSchema).min(1).max(30),
        task: taskSchema,
        trials: z.number().int().min(1).max(10).default(1),
        concurrency: z.number().int().min(1).max(16).default(4),
      }),
      req.body,
    );
    store.project(body.projectId);
    const dataset = requiredProjectResource<Dataset>(
        store,
        'dataset',
        body.datasetId,
        body.projectId,
      ),
      version = body.datasetVersion ?? dataset.version,
      rows = store.datasetRows(dataset.id, version);
    if (!rows.length) throw new HttpError(400, 'Cannot evaluate an empty dataset');
    if (rows.length * body.trials > 100000)
      throw new HttpError(400, 'An experiment may contain at most 100000 cases');
    if (body.task.type === 'openai' && !provider.apiKey)
      throw new HttpError(503, 'No model provider configured. Set OPENAI_API_KEY on the server.');
    if (new Set(body.scorerIds).size !== body.scorerIds.length)
      throw new HttpError(400, 'Duplicate scorer IDs');
    const scorers = body.scorerIds.map((id) =>
      requiredProjectResource<Scorer>(store, 'scorer', id, body.projectId),
    );
    const experiment: Experiment = {
      id: randomUUID(),
      projectId: body.projectId,
      name: body.name,
      description: body.description ?? '',
      datasetId: dataset.id,
      datasetVersion: version,
      status: 'queued',
      executionSource: 'server',
      task: body.task,
      scorerIds: body.scorerIds,
      trials: body.trials,
      concurrency: body.concurrency,
      totalCases: rows.length * body.trials,
      completedCases: 0,
      scores: Object.fromEntries(scorers.map((s) => [s.id, null])),
      latencyMs: null,
      costUsd: null,
      unknownCostCount: 0,
      createdAt: now(),
      finishedAt: null,
      error: null,
    };
    store.transaction(() => store.saveExperiment(experiment, { rows, scorers }));
    queue.enqueue(experiment.id);
    res.status(202).json(experiment);
  });
  app.post('/api/experiments/import', (req, res) => {
    const body = parse(
      z.object({
        projectId: idSchema,
        name: nameSchema,
        datasetId: idSchema,
        datasetVersion: z.number().int().min(1),
        description: z.string().max(10000).optional(),
        cases: z.array(importCaseSchema).min(1).max(100000),
      }),
      req.body,
    );
    store.project(body.projectId);
    const dataset = requiredProjectResource<Dataset>(
        store,
        'dataset',
        body.datasetId,
        body.projectId,
      ),
      rows = store.datasetRows(dataset.id, body.datasetVersion),
      rowIds = new Set(rows.map((r) => r.id));
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const pairs = new Set<string>();
    for (const c of body.cases) {
      if (!rowIds.has(c.rowId))
        throw new HttpError(400, `Imported row ${c.rowId} is absent from the dataset version`);
      const pinnedRow = rowsById.get(c.rowId)!;
      if (
        stableJson(c.input) !== stableJson(pinnedRow.input) ||
        stableJson(c.expected) !== stableJson(pinnedRow.expected)
      )
        throw new HttpError(
          400,
          `Imported case ${c.rowId} does not match the pinned dataset input and expected content`,
        );
      const pair = `${c.rowId}:${c.trial ?? 1}`;
      if (pairs.has(pair)) throw new HttpError(400, 'Duplicate row/trial pair');
      pairs.add(pair);
      if (c.traceId) {
        const trace = store.require<Trace>('trace', c.traceId);
        if (trace.projectId !== body.projectId)
          throw new HttpError(400, 'Imported trace belongs to another project');
      }
    }
    const id = randomUUID(),
      scorerIds = [...new Set(body.cases.flatMap((c) => Object.keys(c.scores)))];
    const cases: EvalCase[] = body.cases.map((c) => ({
      ...c,
      id: randomUUID(),
      experimentId: id,
      trial: c.trial ?? 1,
      scoreErrors: c.scoreErrors ?? {},
      latencyMs: c.latencyMs ?? 0,
      costUsd: c.costUsd ?? null,
      inputTokens: c.inputTokens ?? 0,
      outputTokens: c.outputTokens ?? 0,
      traceId: c.traceId ?? null,
      error: c.error ?? null,
    }));
    const importedScorers: Scorer[] = scorerIds
      .map((scoreId) => store.get<Scorer>('scorer', scoreId))
      .filter((s): s is Scorer => !!s && s.projectId === body.projectId);
    const base: Experiment = {
      id,
      projectId: body.projectId,
      name: body.name,
      description: body.description ?? 'Imported independently executed evaluation.',
      datasetId: body.datasetId,
      datasetVersion: body.datasetVersion,
      status: 'completed',
      executionSource: 'sdk-import',
      task: { type: 'echo' },
      scorerIds,
      trials: Math.max(...cases.map((c) => c.trial)),
      concurrency: 1,
      totalCases: cases.length,
      completedCases: cases.length,
      scores: {},
      latencyMs: null,
      costUsd: null,
      unknownCostCount: 0,
      createdAt: now(),
      finishedAt: now(),
      error: null,
    };
    const experiment = aggregateExperiment(base, cases);
    store.transaction(() => {
      store.saveExperiment(experiment, { rows, scorers: importedScorers });
      for (const c of cases) store.put('case', c, body.projectId, id);
    });
    res.status(201).json(experiment);
  });
  app.get('/api/experiments/:id/export', (req, res) =>
    res.attachment('mindtrust-experiment.json').json(store.experimentDetail(parameter(req, 'id'))),
  );
  app.get('/api/experiments/:id', (req, res) =>
    res.json(store.experimentDetail(parameter(req, 'id'))),
  );
  app.post('/api/experiments/:id/cancel', (req, res) =>
    res.json(queue.cancel(parameter(req, 'id'))),
  );
  app.get('/api/compare', (req, res) => {
    const baseline = store.require<Experiment>('experiment', parse(idSchema, req.query.baseline)),
      candidate = store.require<Experiment>('experiment', parse(idSchema, req.query.candidate));
    if (baseline.projectId !== candidate.projectId)
      throw new HttpError(400, 'Experiments must belong to the same project');
    const b = store.list<EvalCase>('case', undefined, baseline.id),
      c = store.list<EvalCase>('case', undefined, candidate.id),
      bm = new Map(b.map((v) => [JSON.stringify([v.rowId, v.trial]), v])),
      cm = new Map(c.map((v) => [JSON.stringify([v.rowId, v.trial]), v]));
    const scoreIds = [
      ...new Set([...Object.keys(baseline.scores), ...Object.keys(candidate.scores)]),
    ];
    const deltasFor = (
      a: Record<string, number | null> | undefined,
      z: Record<string, number | null> | undefined,
    ) =>
      Object.fromEntries(
        scoreIds.map((id) => [
          id,
          typeof a?.[id] === 'number' && typeof z?.[id] === 'number' ? z[id]! - a[id]! : null,
        ]),
      );
    const rows: ComparisonRow[] = [...new Set([...bm.keys(), ...cm.keys()])].map((key) => {
      const baseline = bm.get(key) ?? null,
        candidate = cm.get(key) ?? null,
        v = baseline ?? candidate!;
      return {
        rowId: v.rowId,
        trial: v.trial,
        input: v.input,
        baseline,
        candidate,
        deltas: deltasFor(baseline?.scores, candidate?.scores),
      };
    });
    const sameRevision =
      baseline.datasetId === candidate.datasetId &&
      baseline.datasetVersion === candidate.datasetVersion;
    const fullyAligned = rows.every((r) => r.baseline && r.candidate);
    const sameContents = rows.every(
      (r) =>
        !r.baseline ||
        !r.candidate ||
        (stableJson(r.baseline.input) === stableJson(r.candidate.input) &&
          stableJson(r.baseline.expected) === stableJson(r.candidate.expected)),
    );
    const finished = [baseline, candidate].every((e) => e.status === 'completed');
    const bs = store.experimentSnapshot(baseline.id).scorers,
      cs = store.experimentSnapshot(candidate.id).scorers;
    const changedScorers = bs.some((s) => {
      const candidateScorer = cs.find((c) => c.id === s.id);
      return (
        candidateScorer &&
        (candidateScorer.type !== s.type ||
          stableJson(candidateScorer.config) !== stableJson(s.config))
      );
    });
    const unverifiedScorers = scoreIds.some(
      (id) => !bs.some((s) => s.id === id) || !cs.some((s) => s.id === id),
    );
    const comparable = sameRevision && fullyAligned && sameContents && finished && !changedScorers;
    const warnings = [
      !sameRevision
        ? 'Experiments use different dataset revisions; matched IDs do not establish equivalent inputs.'
        : null,
      !fullyAligned ? 'Some rows or trials are unmatched.' : null,
      !sameContents ? 'Matched row IDs have different input or expected content.' : null,
      !finished ? 'One or both experiments are not completed.' : null,
      changedScorers ? 'Scorer definitions changed between experiments.' : null,
      unverifiedScorers
        ? 'Some scores do not have matching server-side scorer snapshots; verify their external implementation before interpreting deltas.'
        : null,
    ].filter(Boolean);
    const result: Comparison = {
      baseline,
      candidate,
      rows,
      deltas: comparable
        ? deltasFor(baseline.scores, candidate.scores)
        : Object.fromEntries(scoreIds.map((id) => [id, null])),
      comparable,
      warning: warnings.length ? warnings.join(' ') : null,
    };
    res.json(result);
  });

  app.get('/api/prompts', (req, res) =>
    res.json(store.list<Prompt>('prompt', projectQuery(req, store))),
  );
  app.post('/api/prompts', (req, res) => {
    const body = parse(
      z.object({
        projectId: idSchema,
        name: nameSchema,
        description: z.string().max(10000).optional(),
        system: z.string().max(100000).optional(),
        template: z.string().min(1).max(100000),
        model: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );
    store.project(body.projectId);
    const prompt: Prompt = {
      ...body,
      id: randomUUID(),
      description: body.description ?? '',
      system: body.system ?? '',
      model: body.model ?? 'gpt-4.1-mini',
      version: 1,
      updatedAt: now(),
    };
    store.transaction(() => store.savePromptVersion(prompt));
    res.status(201).json(prompt);
  });
  app.get('/api/prompts/:id', (req, res) => {
    const id = parameter(req, 'id');
    res.json({ prompt: store.require<Prompt>('prompt', id), versions: store.promptVersions(id) });
  });
  app.post('/api/prompts/:id/versions', (req, res) => {
    const id = parameter(req, 'id'),
      body = parse(
        z.object({
          system: z.string().max(100000),
          template: z.string().min(1).max(100000),
          model: z.string().min(1).max(200),
          description: z.string().max(10000).optional(),
        }),
        req.body,
      );
    const prompt = store.require<Prompt>('prompt', id);
    const updated: Prompt = { ...prompt, ...body, version: prompt.version + 1, updatedAt: now() };
    store.transaction(() => store.savePromptVersion(updated));
    res.status(201).json(updated);
  });
  app.post('/api/playground', async (req, res) => {
    const body = parse(
      z.object({ projectId: idSchema, task: taskSchema, input: jsonSchema }),
      req.body,
    );
    store.project(body.projectId);
    const result = await executeTask(body.task, body.input, provider);
    const traceId = taskTrace(
      store,
      body.projectId,
      body.task.type === 'template'
        ? 'Playground · deterministic template'
        : `Playground · ${body.task.type}`,
      body.input,
      result,
      body.task,
      { source: 'playground' },
    );
    res.json({ ...result, traceId });
  });

  app.get('/api/keys', (req, res) => {
    admin(req);
    res.json(store.keys());
  });
  app.post('/api/keys', (req, res) => {
    admin(req);
    const body = parse(z.object({ name: nameSchema }), req.body),
      key = `mt_${randomBytes(32).toString('hex')}`;
    const value: ApiKey = {
      id: randomUUID(),
      name: body.name,
      prefix: key.slice(0, 11),
      createdAt: now(),
    };
    store.db
      .prepare('INSERT INTO api_keys(id,name,prefix,hash,created_at) VALUES(?,?,?,?,?)')
      .run(value.id, value.name, value.prefix, hash(key), value.createdAt);
    res.status(201).json({ ...value, key });
  });
  app.delete('/api/keys/:id', (req, res) => {
    admin(req);
    const result = store.db.prepare('DELETE FROM api_keys WHERE id=?').run(parameter(req, 'id'));
    if (!result.changes) throw new HttpError(404, 'API key not found');
    res.json({ ok: true });
  });

  app.use(['/api', '/v1'], (_req, res) => res.status(404).json({ error: 'API route not found' }));
  const dist = resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body exceeds 5 MB' });
      return;
    }
    if (
      error instanceof SyntaxError &&
      (error as SyntaxError & { status?: number }).status === 400
    ) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errors);
  queue.resume();
  let closed = false;
  return {
    app,
    store,
    close: async () => {
      if (closed) return;
      closed = true;
      await queue.close();
      store.close();
    },
  };
}
