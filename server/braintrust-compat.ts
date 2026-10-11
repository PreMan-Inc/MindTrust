import { createHash, randomUUID } from 'node:crypto';
import { json as jsonParser, type Express, type Request, type Response } from 'express';
import type {
  Annotation,
  Dataset,
  DatasetRow,
  EvalCase,
  Experiment,
  Json,
  Meta,
  Project,
  Trace,
} from '../shared/types.ts';
import { aggregateExperiment, stableJson } from './evaluation.ts';
import { HttpError, Store } from './store.ts';
import { writeTrace } from './traces.ts';

/** A deliberately bounded wire adapter, contract-tested against braintrust@3.37.2. */
export interface BraintrustAccess {
  authenticate(req: Request): void;
  requireProject(req: Request, projectId: string, permission: 'read' | 'write'): void;
  requireAdmin(req: Request): void;
  listProjects(req: Request): Project[];
}
type Row = Record<string, Json>;
type ObjectType = 'project_logs' | 'dataset' | 'experiment';
interface Target {
  type: ObjectType;
  id: string;
  projectId: string;
}
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const now = () => new Date().toISOString();
const rootSql = "COALESCE(json_extract(value,'$.root_span_id'),json_extract(value,'$.span_id'),id)";
const rootKey = (r: Row) =>
  optionalString(r.root_span_id) ?? optionalString(r.span_id) ?? str(r.id, 'id');
const owns = (o: object, k: string) => Object.hasOwn(o, k);
const clone = <T>(v: T): T => structuredClone(v);
const record = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
function object(v: unknown, label = 'body'): Row {
  if (!record(v)) throw new HttpError(400, `${label} must be an object`);
  checkJson(v);
  return v;
}
function checkJson(v: unknown, depth = 0): void {
  if (
    record(v) &&
    ['braintrust_attachment', 'external_attachment', 'inline_attachment'].includes(String(v.type))
  )
    unsupported('attachment references and uploads');
  if (depth > 64) throw new HttpError(400, 'JSON nesting exceeds 64 levels');
  if (typeof v === 'number' && !Number.isFinite(v)) throw new HttpError(400, 'Non-finite number');
  if (Array.isArray(v)) for (const x of v) checkJson(x, depth + 1);
  else if (record(v))
    for (const [key, x] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new HttpError(400, `Unsafe object key: ${key}`);
      checkJson(x, depth + 1);
    }
}
function str(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500)
    throw new HttpError(400, `${label} must be a nonempty string of at most 500 characters`);
  return v;
}
function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function int(v: unknown, fallback: number, maximum = 10000): number {
  if (v === undefined) return fallback;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > maximum)
    throw new HttpError(400, 'Invalid positive integer');
  return n;
}
function unsupported(message: string): never {
  throw new HttpError(501, `Braintrust compatibility: ${message} is not supported`);
}
function exactKeys(o: Row, keys: string[], context: string) {
  const extra = Object.keys(o).filter((key) => !keys.includes(key));
  if (extra.length) unsupported(`${context} fields ${extra.join(', ')}`);
}
function deterministic(...parts: string[]): string {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function version(v: number) {
  return String(v).padStart(20, '0');
}
function merge(base: Row, patch: Row, replace: Set<string>, path: string[] = []): Row {
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    const at = [...path, key];
    if (!replace.has(JSON.stringify(at)) && record(out[key]) && record(value))
      out[key] = merge(out[key], value, replace, at);
    else if (
      path.length === 0 &&
      key === 'tags' &&
      !replace.has(JSON.stringify(at)) &&
      Array.isArray(out[key]) &&
      Array.isArray(value)
    )
      out[key] = [...new Set([...out[key], ...value])];
    else out[key] = clone(value);
  }
  return out;
}
function assertRow(row: Row) {
  str(row.id, 'row.id');
  if ((row.id as string).length > 200)
    throw new HttpError(400, 'Row IDs must be at most 200 characters');
  for (const key of Object.keys(row))
    if (
      key.startsWith('_') &&
      ![
        '_is_merge',
        '_merge_paths',
        '_object_delete',
        '_xact_id',
        '_audit_source',
        '_audit_metadata',
      ].includes(key)
    )
      unsupported(`row control ${key}`);
  for (const key of ['_is_merge', '_object_delete'])
    if (owns(row, key) && typeof row[key] !== 'boolean')
      throw new HttpError(400, `${key} must be boolean`);
  if (
    owns(row, '_merge_paths') &&
    (!Array.isArray(row._merge_paths) ||
      row._merge_paths.some(
        (p) => !Array.isArray(p) || !p.length || p.some((x) => typeof x !== 'string'),
      ))
  )
    throw new HttpError(400, '_merge_paths must contain nonempty string paths');
  if (row._merge_paths && !row._is_merge)
    throw new HttpError(400, '_merge_paths requires _is_merge');
  if (
    row.tags !== undefined &&
    row.tags !== null &&
    (!Array.isArray(row.tags) || row.tags.some((x) => typeof x !== 'string'))
  )
    throw new HttpError(400, 'tags must be strings');
  if (row.metadata !== undefined && !record(row.metadata))
    throw new HttpError(400, 'metadata must be an object');
  if (row.scores !== undefined) {
    if (!record(row.scores)) throw new HttpError(400, 'scores must be an object');
    for (const n of Object.values(row.scores))
      if (n !== null && (typeof n !== 'number' || n < 0 || n > 1))
        throw new HttpError(400, 'Scores must be null or numbers between 0 and 1');
  }
  if (
    row.span_parents !== undefined &&
    row.span_parents !== null &&
    (!Array.isArray(row.span_parents) || row.span_parents.some((p) => typeof p !== 'string'))
  )
    throw new HttpError(400, 'span_parents must be strings');
  if (Array.isArray(row.span_parents) && row.span_parents.length > 1)
    unsupported('multiple span parents');
  if (row.metrics !== undefined) {
    if (!record(row.metrics)) throw new HttpError(400, 'metrics must be an object');
    for (const key of ['start', 'end', 'prompt_tokens', 'completion_tokens', 'cost']) {
      const n = row.metrics[key];
      if (n !== undefined && (typeof n !== 'number' || n < 0))
        throw new HttpError(400, `metrics.${key} must be nonnegative`);
    }
    if (
      typeof row.metrics.start === 'number' &&
      typeof row.metrics.end === 'number' &&
      row.metrics.end < row.metrics.start
    )
      throw new HttpError(400, 'metrics.end precedes start');
  }
}

export function mountBraintrustCompatibility(app: Express, store: Store, access: BraintrustAccess) {
  // Python 0.45 sends JSON bytes without a Content-Type on this legacy endpoint.
  app.use(
    '/logs3',
    (req, _res, next) => {
      try {
        access.authenticate(req);
        next();
      } catch (error) {
        next(error);
      }
    },
    jsonParser({ type: () => true, limit: '5mb', strict: true }),
  );
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS bt_objects(type TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(type,id));
    CREATE TABLE IF NOT EXISTS bt_rows(type TEXT NOT NULL,object_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(type,object_id,id));
    CREATE INDEX IF NOT EXISTS bt_rows_root ON bt_rows(type,object_id,${rootSql});
    CREATE TABLE IF NOT EXISTS bt_revisions(type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(type,id));
    CREATE TABLE IF NOT EXISTS bt_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,object_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bt_dataset_snapshots(dataset_id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(dataset_id,version));
  `);
  const getObject = (type: string, id: string): Row => {
    const v = store.db
      .prepare('SELECT value FROM bt_objects WHERE type=? AND id=?')
      .get(type, id) as { value: string } | undefined;
    return v ? JSON.parse(v.value) : {};
  };
  const setObject = (type: string, id: string, data: Row) =>
    store.db
      .prepare(
        'INSERT INTO bt_objects(type,id,value) VALUES(?,?,?) ON CONFLICT(type,id) DO UPDATE SET value=excluded.value',
      )
      .run(type, id, JSON.stringify(data));
  const rows = (target: Target): Row[] =>
    (
      store.db
        .prepare('SELECT value FROM bt_rows WHERE type=? AND object_id=? ORDER BY rowid')
        .all(target.type, target.id) as { value: string }[]
    ).map((x) => JSON.parse(x.value));
  const rowById = (target: Target, id: string): Row | undefined => {
    const r = store.db
      .prepare('SELECT value FROM bt_rows WHERE type=? AND object_id=? AND id=?')
      .get(target.type, target.id, id) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  };
  const target = (
    req: Request,
    type: ObjectType,
    id: string,
    permission: 'read' | 'write',
  ): Target => {
    const projectId =
      type === 'project_logs'
        ? store.project(id).id
        : store.require<Dataset | Experiment>(type, id).projectId;
    access.requireProject(req, projectId, permission);
    return { type, id, projectId };
  };
  const route = (
    method: 'get' | 'post',
    path: string | string[],
    handler: (req: Request, res: Response) => unknown,
  ) =>
    app[method](path, (req, res, next) => {
      try {
        access.authenticate(req);
        res.setHeader('Cache-Control', 'no-store');
        handler(req, res);
      } catch (error) {
        next(error);
      }
    });
  const projectInfo = (p: Project) => ({
    id: p.id,
    name: p.name,
    org_id: ORG_ID,
    description: p.description,
    created: p.createdAt,
  });
  const datasetInfo = (d: Dataset) => ({
    ...getObject('dataset', d.id),
    id: d.id,
    name: d.name,
    project_id: d.projectId,
    description: d.description,
  });
  const experimentInfo = (e: Experiment) => ({
    ...getObject('experiment', e.id),
    id: e.id,
    name: e.name,
    project_id: e.projectId,
    description: e.description,
    created: e.createdAt,
    dataset_id: e.datasetId,
    dataset_version: version(e.datasetVersion),
  });
  function resolveProject(
    req: Request,
    body: Row,
    permission: 'read' | 'write',
    createIfMissing = false,
  ): Project {
    if (body.org_id !== undefined && body.org_id !== ORG_ID)
      throw new HttpError(403, 'Unknown organization');
    if (body.org_name !== undefined && body.org_name !== 'MindTrust')
      throw new HttpError(403, 'Unknown organization');
    if (body.project_id !== undefined) {
      const p = store.project(str(body.project_id, 'project_id'));
      access.requireProject(req, p.id, permission);
      if (body.project_name !== undefined && body.project_name !== p.name)
        throw new HttpError(400, 'Project name and ID disagree');
      return p;
    }
    const name = str(body.project_name, 'project_name');
    const matches = store.list<Project>('project').filter((p) => p.name === name);
    if (matches.length > 1) throw new HttpError(409, 'Ambiguous project name; use project_id');
    if (matches[0]) {
      access.requireProject(req, matches[0].id, permission);
      return matches[0];
    }
    if (permission === 'read' && !createIfMissing) throw new HttpError(404, 'Project not found');
    access.requireAdmin(req);
    const p: Project = { id: randomUUID(), name, description: '', createdAt: now() };
    store.put('project', p, p.id);
    return p;
  }
  function nativeRow(r: Row): DatasetRow {
    if (!owns(r, 'input')) throw new HttpError(400, 'Dataset row requires input');
    return {
      id: str(r.id, 'row.id'),
      input: r.input,
      expected: r.expected ?? null,
      hasExpected: owns(r, 'expected'),
      metadata: record(r.metadata) ? r.metadata : {},
      tags: (r.tags ?? []) as string[],
    };
  }
  function syncDataset(t: Target) {
    const dataset = store.require<Dataset>('dataset', t.id),
      raw = rows(t);
    const native = raw.map(nativeRow);
    const saved = store.db
      .prepare('SELECT value FROM bt_dataset_snapshots WHERE dataset_id=? AND version=?')
      .get(t.id, dataset.version) as { value: string } | undefined;
    if (
      stableJson(store.datasetRows(t.id)) === stableJson(native) &&
      saved &&
      stableJson(JSON.parse(saved.value)) === stableJson(raw)
    )
      return;
    const updated = {
      ...dataset,
      version: dataset.version + 1,
      rowCount: native.length,
      updatedAt: now(),
    };
    store.saveDatasetSnapshot(updated, native);
    store.db
      .prepare('INSERT INTO bt_dataset_snapshots(dataset_id,version,value) VALUES(?,?,?)')
      .run(t.id, updated.version, JSON.stringify(raw));
  }
  function datasetRows(t: Target, requested?: unknown): Row[] {
    const dataset = store.require<Dataset>('dataset', t.id);
    const v =
      requested === undefined
        ? dataset.version
        : int(requested, dataset.version, Number.MAX_SAFE_INTEGER);
    const native = store.datasetRows(t.id, v);
    const saved = store.db
      .prepare('SELECT value FROM bt_dataset_snapshots WHERE dataset_id=? AND version=?')
      .get(t.id, v) as { value: string } | undefined;
    const data: Row[] = saved
      ? JSON.parse(saved.value)
      : native.map((r) => ({
          id: r.id,
          input: r.input,
          ...(r.hasExpected === false ? {} : { expected: r.expected }),
          metadata: r.metadata,
          tags: r.tags,
          dataset_id: t.id,
        }));
    return data.map((r) => ({ ...r, _xact_id: version(v) }));
  }
  function seedDatasetRaw(t: Target) {
    const d = store.require<Dataset>('dataset', t.id);
    if (
      store.db
        .prepare('SELECT 1 FROM bt_dataset_snapshots WHERE dataset_id=? AND version=?')
        .get(t.id, d.version)
    )
      return;
    // Native editing advances its own immutable revision. Reconcile canonical columns,
    // retaining compatibility-only columns for row IDs still present in that revision.
    const existing = new Map(rows(t).map((r) => [str(r.id, 'id'), r]));
    const raw = store.datasetRows(t.id).map((r) => {
      const value: Row = {
        ...existing.get(r.id),
        id: r.id,
        input: r.input,
        metadata: r.metadata,
        tags: r.tags,
        dataset_id: t.id,
      };
      if (r.hasExpected === false) delete value.expected;
      else value.expected = r.expected;
      return value;
    });
    store.db.prepare('DELETE FROM bt_rows WHERE type=? AND object_id=?').run(t.type, t.id);
    for (const r of raw)
      store.db
        .prepare('INSERT INTO bt_rows(type,object_id,id,value) VALUES(?,?,?,?)')
        .run(t.type, t.id, str(r.id, 'id'), JSON.stringify(r));
    store.db
      .prepare('INSERT INTO bt_dataset_snapshots(dataset_id,version,value) VALUES(?,?,?)')
      .run(t.id, d.version, JSON.stringify(raw));
  }
  function projectRowTarget(req: Request, row: Row): Target {
    const descriptors = ['experiment_id', 'dataset_id', 'project_id'].filter((k) => owns(row, k));
    if (
      descriptors.length !== 1 ||
      row.prompt_session_id !== undefined ||
      row.function_data !== undefined
    )
      throw new HttpError(400, 'Exactly one supported container ID is required per row');
    const key = descriptors[0];
    if (row.log_id !== undefined && (key !== 'project_id' || row.log_id !== 'g'))
      unsupported('log_id other than project logs g');
    return target(
      req,
      key === 'project_id' ? 'project_logs' : key === 'dataset_id' ? 'dataset' : 'experiment',
      str(row[key], key),
      'write',
    );
  }
  function syncTraces(t: Target, changedRoots: Set<string>, comments: Row[]) {
    const groups = new Map<string, Row[]>();
    const select = store.db.prepare(
      `SELECT value FROM bt_rows WHERE type=? AND object_id=? AND ${rootSql}=? AND json_type(value,'$.comment') IS NULL ORDER BY rowid`,
    );
    for (const root of changedRoots) {
      const group = (select.all(t.type, t.id, root) as { value: string }[]).map(
        (row) => JSON.parse(row.value) as Row,
      );
      if (group.length) groups.set(root, group);
    }
    for (const [rootId, group] of groups) {
      const spanIds = group.map((r) => optionalString(r.span_id) ?? str(r.id, 'id'));
      if (new Set(spanIds).size !== spanIds.length)
        throw new HttpError(409, 'Different rows cannot share a span ID within one trace');
      if (group.filter((r) => !Array.isArray(r.span_parents) || !r.span_parents.length).length > 1)
        throw new HttpError(400, 'A trace cannot have multiple root spans');
      const root =
        group.find((r) => !Array.isArray(r.span_parents) || !r.span_parents.length) ?? group[0];
      const traceId = deterministic(t.type, t.id, rootId);
      const spans = group.map((r) => {
        const metrics = record(r.metrics) ? r.metrics : {},
          attr = record(r.span_attributes) ? r.span_attributes : {};
        const start =
          typeof metrics.start === 'number'
            ? metrics.start * 1000
            : Date.parse(optionalString(r.created) ?? now());
        const end = typeof metrics.end === 'number' ? metrics.end * 1000 : start;
        if (!Number.isFinite(start) || !Number.isFinite(end))
          throw new HttpError(400, 'Invalid span timestamp');
        const kind: 'llm' | 'tool' | 'retrieval' | 'agent' | 'function' = [
          'llm',
          'tool',
          'retrieval',
          'agent',
        ].includes(String(attr.type))
          ? (attr.type as 'llm' | 'tool' | 'retrieval' | 'agent')
          : 'function';
        const metadata: Meta = {
          ...(record(r.metadata) ? r.metadata : {}),
          _mindtrust_braintrust: {
            row_id: r.id,
            root_span_id: rootId,
            ...(r.scores ? { scores: r.scores } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.context ? { context: r.context } : {}),
            ...(r.span_attributes ? { span_attributes: r.span_attributes } : {}),
          },
        };
        return {
          id: optionalString(r.span_id) ?? str(r.id, 'id'),
          parentId: Array.isArray(r.span_parents) ? ((r.span_parents[0] as string) ?? null) : null,
          name: optionalString(attr.name) ?? 'Braintrust span',
          kind,
          status: r.error ? ('error' as const) : ('ok' as const),
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
          input: r.input ?? null,
          output: r.output ?? null,
          metadata,
          model: optionalString(metadata.model) ?? null,
          inputTokens: typeof metrics.prompt_tokens === 'number' ? metrics.prompt_tokens : 0,
          outputTokens:
            typeof metrics.completion_tokens === 'number' ? metrics.completion_tokens : 0,
          costUsd: typeof metrics.cost === 'number' ? metrics.cost : null,
        };
      });
      // Rebuild this materialized trace so a full row replacement cannot retain old fields.
      store.db.prepare("DELETE FROM records WHERE kind='span' AND parent_id=?").run(traceId);
      store.db.prepare('DELETE FROM trace_sources WHERE trace_id=?').run(traceId);
      const trace = writeTrace(store, t.projectId, {
        id: traceId,
        name:
          optionalString((record(root.span_attributes) ? root.span_attributes : {}).name) ??
          'Braintrust trace',
        input: root.input ?? null,
        output: root.output ?? null,
        tags: (root.tags ?? []) as string[],
        metadata: {
          ...(record(root.metadata) ? root.metadata : {}),
          _mindtrust_braintrust: {
            object_type: t.type,
            object_id: t.id,
            root_span_id: rootId,
            row_id: root.id,
          },
        },
        status: group.some((r) => !!r.error) ? 'error' : 'ok',
        model: spans.find((span) => span.model)?.model ?? null,
        spans,
      });
      if (
        t.type === 'experiment' &&
        (!Array.isArray(root.span_parents) || root.span_parents.length === 0)
      )
        syncCase(t, root, trace, group);
    }
    for (const r of comments) {
      const origin = record(r.origin) ? r.origin : {};
      const original = typeof origin.id === 'string' ? rowById(t, origin.id) : undefined;
      if (!original) throw new HttpError(400, 'Feedback references a missing row');
      const rootId =
        optionalString(original.root_span_id) ??
        optionalString(original.span_id) ??
        str(original.id, 'id');
      const annotation: Annotation = {
        id: deterministic('feedback', t.type, t.id, str(r.id, 'id')),
        projectId: t.projectId,
        targetType: 'trace',
        targetId: deterministic(t.type, t.id, rootId),
        label: 'needs_review',
        comment:
          typeof r.comment === 'string'
            ? r.comment
            : (optionalString(record(r.comment) ? r.comment.text : undefined) ?? ''),
        expected: r.expected ?? null,
        createdAt: optionalString(r.created) ?? now(),
      };
      store.put('annotation', annotation, t.projectId);
    }
  }
  function syncCase(t: Target, r: Row, trace: Trace, group: Row[]) {
    const experiment = store.require<Experiment>('experiment', t.id);
    const objectData = getObject('experiment', t.id);
    const origin = record(r.origin) ? r.origin : {};
    const rowId =
      typeof origin.id === 'string' && origin.object_type === 'dataset'
        ? origin.id
        : typeof r.dataset_record_id === 'string'
          ? r.dataset_record_id
          : deterministic(
              'inline-input',
              stableJson({
                input: r.input ?? null,
                hasExpected: owns(r, 'expected'),
                expected: r.expected ?? null,
              }),
            );
    if (origin.object_type === 'dataset' && origin.object_id !== experiment.datasetId)
      throw new HttpError(400, 'Experiment row origin references a different dataset');
    if (!objectData.inline_dataset) {
      const expectedRow = store.experimentSnapshot(t.id).rows.find((v) => v.id === rowId);
      if (
        !expectedRow ||
        stableJson(expectedRow.input) !== stableJson(r.input ?? null) ||
        (expectedRow.hasExpected !== false) !== owns(r, 'expected') ||
        stableJson(expectedRow.expected) !== stableJson(r.expected ?? null)
      )
        throw new HttpError(400, 'Experiment row does not match its pinned dataset revision');
    } else {
      const dataset = store.require<Dataset>('dataset', experiment.datasetId);
      const existing = store.datasetRows(dataset.id);
      if (!existing.some((v) => v.id === rowId)) {
        const next = [
          ...existing,
          nativeRow({
            id: rowId,
            input: r.input ?? null,
            ...(owns(r, 'expected') ? { expected: r.expected } : {}),
          }),
        ];
        store.saveDatasetSnapshot(
          { ...dataset, version: dataset.version + 1, rowCount: next.length, updatedAt: now() },
          next,
        );
        experiment.datasetVersion = dataset.version + 1;
        store.saveExperiment(experiment, { rows: next, scorers: [] });
      }
    }
    const id = deterministic('case', t.id, str(r.id, 'id'));
    const previous = store.get<EvalCase>('case', id);
    const other = store.list<EvalCase>('case', t.projectId, t.id).filter((c) => c.rowId === rowId);
    // SDK 3.37 emits successful scores on immediate scorer spans, not the eval root.
    const scores: Record<string, number | null> = {};
    for (const child of group)
      if (
        record(child.span_attributes) &&
        child.span_attributes.purpose === 'scorer' &&
        child.span_attributes.type === 'score' &&
        Array.isArray(child.span_parents) &&
        child.span_parents[0] === r.span_id &&
        record(child.scores)
      ) {
        for (const [name, value] of Object.entries(child.scores)) {
          if (owns(scores, name) && scores[name] !== value)
            unsupported(`ambiguous repeated scorer name ${name}`);
          scores[name] = value as number | null;
        }
      }
    Object.assign(scores, record(r.scores) ? r.scores : {});
    const errors =
      record(r.metadata) && record(r.metadata.scorer_errors) ? r.metadata.scorer_errors : {};
    const scoreErrors = Object.fromEntries(
      Object.entries(errors).map(([name, value]) => [
        name,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]),
    );
    const trial = previous?.trial ?? Math.max(0, ...other.map((c) => c.trial)) + 1;
    if (trial > 10) unsupported('more than 10 trials for one dataset case');
    const item: EvalCase = {
      id,
      experimentId: t.id,
      rowId,
      trial,
      input: r.input ?? null,
      expected: r.expected ?? null,
      output: r.output ?? null,
      scores,
      scoreErrors,
      error: r.error ? (typeof r.error === 'string' ? r.error : JSON.stringify(r.error)) : null,
      latencyMs: trace.latencyMs,
      costUsd: trace.costUsd,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      traceId: trace.id,
    };
    store.put('case', item, t.projectId, t.id);
    const cases = store.list<EvalCase>('case', t.projectId, t.id);
    const updated = aggregateExperiment(
      {
        ...experiment,
        totalCases: cases.length,
        trials: Math.max(1, ...cases.map((c) => c.trial)),
        status: 'running',
        finishedAt: null,
      },
      cases,
    );
    store.put('experiment', updated, t.projectId);
  }
  function ingest(req: Request, input: Row[]): void {
    if (!input.length || input.length > 10000) throw new HttpError(400, 'Expected 1..10000 rows');
    const entries = input.map((r) => {
      assertRow(r);
      return { r, t: projectRowTarget(req, r) };
    });
    store.transaction(() => {
      const touched = new Map<string, Target>();
      const changedRoots = new Map<string, Set<string>>(),
        comments = new Map<string, Row[]>();
      const track = (t: Target, value: Row) => {
        const key = `${t.type}:${t.id}`;
        if (t.type === 'dataset') {
          if (value.comment !== undefined) unsupported('dataset comments');
          return;
        }
        if (value.comment !== undefined) {
          comments.set(key, [...(comments.get(key) ?? []), value]);
          return;
        }
        const roots = changedRoots.get(key) ?? new Set<string>();
        roots.add(rootKey(value));
        changedRoots.set(key, roots);
      };
      for (const t of new Map(
        entries.filter((v) => v.t.type === 'dataset').map(({ t }) => [t.id, t]),
      ).values())
        seedDatasetRaw(t);
      for (const { r, t } of entries) {
        const id = str(r.id, 'id'),
          previous = rowById(t, id);
        if (r._audit_source !== undefined && r.comment === undefined && !previous)
          throw new HttpError(400, 'Feedback references a missing row');
        if (r._object_delete) {
          if (t.type !== 'dataset') unsupported('deleting trace or experiment rows');
          if (!previous) continue;
          store.db
            .prepare('DELETE FROM bt_rows WHERE type=? AND object_id=? AND id=?')
            .run(t.type, t.id, id);
          touched.set(`${t.type}:${t.id}`, t);
        } else {
          const value = clone(r);
          for (const key of ['_is_merge', '_merge_paths', '_object_delete', '_xact_id'])
            delete value[key];
          const merged = r._is_merge
            ? merge(
                previous ?? {},
                value,
                new Set(((r._merge_paths ?? []) as string[][]).map((p) => JSON.stringify(p))),
              )
            : value;
          if (t.type !== 'dataset' && previous)
            for (const key of ['span_id', 'root_span_id']) {
              if (
                previous[key] !== undefined &&
                merged[key] !== undefined &&
                previous[key] !== merged[key]
              )
                throw new HttpError(409, `Cannot change ${key} of an existing row`);
              if (previous[key] !== undefined && merged[key] === undefined)
                merged[key] = previous[key];
            }
          assertRow(merged);
          if (previous && (previous.comment !== undefined) !== (merged.comment !== undefined))
            throw new HttpError(
              409,
              'Cannot change an existing row between comment and span/data kinds',
            );
          if (stableJson(previous ?? null) === stableJson(merged)) continue;
          store.db
            .prepare(
              'INSERT INTO bt_rows(type,object_id,id,value) VALUES(?,?,?,?) ON CONFLICT(type,object_id,id) DO UPDATE SET value=excluded.value',
            )
            .run(t.type, t.id, id, JSON.stringify(merged));
          touched.set(`${t.type}:${t.id}`, t);
          track(t, merged);
        }
        store.db
          .prepare('INSERT INTO bt_events(type,object_id,id,value,created_at) VALUES(?,?,?,?,?)')
          .run(t.type, t.id, id, JSON.stringify(r), now());
      }
      for (const [key, t] of touched) {
        store.db
          .prepare(
            'INSERT INTO bt_revisions(type,id,revision) VALUES(?,?,1) ON CONFLICT(type,id) DO UPDATE SET revision=revision+1',
          )
          .run(t.type, t.id);
        if (t.type === 'dataset') syncDataset(t);
        else syncTraces(t, changedRoots.get(key) ?? new Set(), comments.get(key) ?? []);
      }
    });
  }
  route('post', '/api/apikey/login', (req, res) => {
    const base = process.env.MINDTRUST_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
    res.json({
      org_info: [
        { id: ORG_ID, name: 'MindTrust', api_url: base, git_metadata: { collect: 'none' } },
      ],
    });
  });
  route('get', '/ping', (_req, res) => res.json({ status: 'ok' }));
  route('get', '/version', (_req, res) =>
    res.json({ version: 'mindtrust-compat-1', logs3_payload_max_bytes: null }),
  );
  route('get', '/api/project', (req, res) => {
    if (req.query.id !== undefined) {
      const p = store.project(str(req.query.id, 'id'));
      access.requireProject(req, p.id, 'read');
      return res.json(projectInfo(p));
    }
    res.json({ objects: access.listProjects(req).map(projectInfo) });
  });
  route('post', '/api/project/register', (req, res) => {
    const body = object(req.body);
    exactKeys(body, ['project_name', 'project_id', 'org_id', 'org_name'], 'project registration');
    res.json({ project: projectInfo(resolveProject(req, body, 'write')) });
  });
  function registerDataset(req: Request, body: Row) {
    exactKeys(
      body,
      [
        'org_id',
        'org_name',
        'project_name',
        'project_id',
        'dataset_name',
        'description',
        'metadata',
      ],
      'dataset registration',
    );
    const p = resolveProject(req, body, 'read', true),
      name = str(body.dataset_name, 'dataset_name');
    let d = store.list<Dataset>('dataset', p.id).find((x) => x.name === name);
    if (!d) {
      access.requireProject(req, p.id, 'write');
      d = {
        id: randomUUID(),
        projectId: p.id,
        name,
        description: optionalString(body.description) ?? '',
        version: 1,
        rowCount: 0,
        updatedAt: now(),
      };
      store.transaction(() => {
        store.saveDatasetSnapshot(d!, []);
        setObject('dataset', d!.id, body);
      });
    } else if (owns(body, 'description') || owns(body, 'metadata')) {
      access.requireProject(req, p.id, 'write');
      d = {
        ...d,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      };
      store.transaction(() => {
        store.put('dataset', d!, p.id);
        setObject('dataset', d!.id, { ...getObject('dataset', d!.id), ...body });
      });
    }
    return { project: projectInfo(p), dataset: datasetInfo(d) };
  }
  route('post', '/api/dataset/register', (req, res) =>
    res.json(registerDataset(req, object(req.body))),
  );
  route('post', '/api/self/get_object_info', (req, res) => {
    const body = object(req.body);
    exactKeys(body, ['object_type', 'object_ids'], 'object discovery');
    if (body.object_type !== 'dataset' || !Array.isArray(body.object_ids))
      unsupported('object discovery other than datasets');
    res.json(
      body.object_ids.map((id) => {
        const t = target(req, 'dataset', str(id, 'object_id'), 'read'),
          d = store.require<Dataset>('dataset', t.id);
        return {
          object_type: 'dataset',
          object_id: d.id,
          object_name: d.name,
          org_id: ORG_ID,
          parent_cols: { project: projectInfo(store.project(d.projectId)) },
        };
      }),
    );
  });
  function registerExperiment(req: Request, body: Row) {
    exactKeys(
      body,
      [
        'project_name',
        'project_id',
        'org_id',
        'experiment_name',
        'description',
        'dataset_id',
        'dataset_version',
        'metadata',
        'tags',
        'repo_info',
        'ancestor_commits',
        'base_exp_id',
        'base_experiment',
        'update',
        'public',
      ],
      'experiment registration',
    );
    if (body.public === true) unsupported('public experiment sharing');
    const p = resolveProject(req, body, 'write');
    const name = optionalString(body.experiment_name) ?? `experiment-${randomUUID().slice(0, 8)}`;
    let e = store.list<Experiment>('experiment', p.id).find((x) => x.name === name);
    if (e && body.update !== true)
      throw new HttpError(
        409,
        'Experiment name already exists; choose another name or update:true',
      );
    if (e && e.executionSource !== 'sdk-import')
      throw new HttpError(
        409,
        'Cannot update a server-executed experiment through the compatibility API',
      );
    if (!e)
      store.transaction(() => {
        let d: Dataset;
        const inline = body.dataset_id === undefined;
        if (inline) {
          d = {
            id: randomUUID(),
            projectId: p.id,
            name: `${name} · SDK inputs`,
            description: 'Inputs collected from an external SDK evaluation; not a server task.',
            version: 1,
            rowCount: 0,
            updatedAt: now(),
          };
          store.saveDatasetSnapshot(d, []);
        } else {
          const t = target(req, 'dataset', str(body.dataset_id, 'dataset_id'), 'read');
          if (t.projectId !== p.id) throw new HttpError(400, 'Dataset belongs to another project');
          d = store.require<Dataset>('dataset', t.id);
        }
        const v =
          body.dataset_version === undefined
            ? d.version
            : int(body.dataset_version, d.version, Number.MAX_SAFE_INTEGER);
        let baseId = optionalString(body.base_exp_id);
        if (body.base_experiment !== undefined)
          baseId = store
            .list<Experiment>('experiment', p.id)
            .find((v) => v.name === body.base_experiment)?.id;
        if (baseId) {
          const b = target(req, 'experiment', baseId, 'read');
          if (b.projectId !== p.id) throw new HttpError(400, 'Baseline belongs to another project');
        }
        e = {
          id: randomUUID(),
          projectId: p.id,
          name,
          description: optionalString(body.description) ?? '',
          datasetId: d.id,
          datasetVersion: v,
          executionSource: 'sdk-import',
          status: 'running',
          task: { type: 'external' },
          scorerIds: [],
          trials: 1,
          concurrency: 1,
          totalCases: 0,
          completedCases: 0,
          scores: {},
          latencyMs: null,
          costUsd: null,
          unknownCostCount: 0,
          createdAt: now(),
          finishedAt: null,
          error: null,
        };
        store.saveExperiment(e, { rows: store.datasetRows(d.id, v), scorers: [] });
        setObject('experiment', e.id, {
          ...body,
          inline_dataset: inline,
          ...(baseId ? { base_exp_id: baseId } : {}),
        });
      });
    else {
      if (
        (body.dataset_id !== undefined && body.dataset_id !== e.datasetId) ||
        (body.dataset_version !== undefined &&
          int(body.dataset_version, e.datasetVersion, Number.MAX_SAFE_INTEGER) !== e.datasetVersion)
      )
        throw new HttpError(409, 'Cannot change the dataset of an existing experiment');
    }
    return { project: projectInfo(p), experiment: experimentInfo(e!) };
  }
  route('post', '/api/experiment/register', (req, res) =>
    res.json(registerExperiment(req, object(req.body))),
  );
  route('post', '/api/experiment/get', (req, res) => {
    const body = object(req.body),
      p = resolveProject(req, body, 'read');
    res.json(
      store
        .list<Experiment>('experiment', p.id)
        .filter((e) => e.name === body.experiment_name)
        .map(experimentInfo),
    );
  });
  route('get', '/v1/experiment/:id', (req, res) => {
    const t = target(req, 'experiment', str(req.params.id, 'id'), 'read');
    res.json(experimentInfo(store.require<Experiment>('experiment', t.id)));
  });
  route('post', '/api/base_experiment/get_id', (req, res) => {
    const t = target(req, 'experiment', str(object(req.body).id, 'id'), 'read');
    const baseId = getObject('experiment', t.id).base_exp_id;
    if (!baseId) throw new HttpError(400, 'No base experiment configured');
    const base = target(req, 'experiment', str(baseId, 'base_exp_id'), 'read');
    res.json({
      base_exp_id: base.id,
      base_exp_name: store.require<Experiment>('experiment', base.id).name,
    });
  });
  route('post', '/logs3', (req, res) => {
    const body = object(req.body);
    exactKeys(body, ['rows', 'api_version'], 'logs3');
    if (body.api_version !== undefined && body.api_version !== 2)
      unsupported('api_version other than 2');
    if (!Array.isArray(body.rows)) unsupported('overflow uploads');
    ingest(
      req,
      body.rows.map((r) => object(r, 'row')),
    );
    res.json({ success: true });
  });
  route('post', '/btql', (req, res) => {
    const body = object(req.body);
    exactKeys(
      body,
      ['query', 'version', 'use_columnstore', 'brainstore_realtime', 'query_source'],
      'BTQL request',
    );
    const query = object(body.query, 'query');
    exactKeys(query, ['select', 'from', 'cursor', 'limit'], 'BTQL query');
    if (stableJson(query.select) !== stableJson([{ op: 'star' }])) unsupported('BTQL projections');
    const from = object(query.from, 'from'),
      name = object(from.name, 'from.name');
    exactKeys(from, ['op', 'name', 'args'], 'BTQL source');
    exactKeys(name, ['op', 'name'], 'BTQL name');
    if (
      from.op !== 'function' ||
      name.op !== 'ident' ||
      !Array.isArray(name.name) ||
      name.name.length !== 1 ||
      !['dataset', 'experiment', 'project_logs'].includes(String(name.name[0])) ||
      !Array.isArray(from.args) ||
      from.args.length !== 1
    )
      unsupported('BTQL source');
    const arg = object(from.args[0], 'source argument');
    exactKeys(arg, ['op', 'value'], 'BTQL argument');
    if (arg.op !== 'literal') unsupported('nonliteral BTQL source');
    const t = target(req, name.name[0] as ObjectType, str(arg.value, 'object ID'), 'read');
    if (body.version !== undefined && t.type !== 'dataset')
      unsupported('historical trace or experiment query');
    const page = fetchPage(t, body.version, query.limit, query.cursor);
    res.json({ data: page.events, ...(page.cursor ? { cursor: page.cursor } : {}) });
  });
  function fetchPage(
    t: Target,
    requested: unknown,
    requestedLimit: unknown,
    cursor: unknown,
  ): { events: Row[]; cursor?: string } {
    const v = requested == null ? undefined : requested;
    if (v !== undefined && t.type !== 'dataset')
      unsupported('historical trace or experiment fetch');
    const revision =
      t.type === 'dataset'
        ? int(v, store.require<Dataset>('dataset', t.id).version, Number.MAX_SAFE_INTEGER)
        : ((
            store.db
              .prepare('SELECT revision FROM bt_revisions WHERE type=? AND id=?')
              .get(t.type, t.id) as { revision: number } | undefined
          )?.revision ?? 0);
    let offset = 0;
    if (cursor != null) {
      let parsed: { type: string; id: string; version: unknown; revision: number; offset: number };
      try {
        parsed = JSON.parse(Buffer.from(str(cursor, 'cursor'), 'base64url').toString());
        if (
          parsed.type !== t.type ||
          parsed.id !== t.id ||
          parsed.version !== (v ?? null) ||
          !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0
        )
          throw new Error();
      } catch {
        throw new HttpError(400, 'Invalid cursor for this object/version');
      }
      if (parsed.revision !== revision)
        throw new HttpError(
          409,
          'Object changed during pagination; restart the fetch or use a pinned dataset version',
        );
      offset = parsed.offset;
    }
    const limit = int(requestedLimit, 1000);
    let events: Row[];
    if (t.type === 'dataset') {
      const saved = store.db
        .prepare('SELECT value FROM bt_dataset_snapshots WHERE dataset_id=? AND version=?')
        .get(t.id, revision) as { value: string } | undefined;
      const native = saved
        ? undefined
        : (store.db
            .prepare('SELECT rows_json FROM dataset_versions WHERE dataset_id=? AND version=?')
            .get(t.id, revision) as { rows_json: string } | undefined);
      if (!saved && !native) throw new HttpError(404, 'Dataset version not found');
      events = (
        store.db
          .prepare('SELECT value FROM json_each(?) LIMIT ? OFFSET ?')
          .all(saved?.value ?? native!.rows_json, limit + 1, offset) as { value: string }[]
      ).map((x) => {
        const r = JSON.parse(x.value);
        const value: Row = saved
          ? r
          : {
              id: r.id,
              input: r.input,
              ...(r.hasExpected === false ? {} : { expected: r.expected }),
              metadata: r.metadata,
              tags: r.tags,
              dataset_id: t.id,
            };
        return { ...value, _xact_id: version(revision) };
      });
    } else
      events = (
        store.db
          .prepare(
            'SELECT value FROM bt_rows WHERE type=? AND object_id=? ORDER BY rowid LIMIT ? OFFSET ?',
          )
          .all(t.type, t.id, limit + 1, offset) as { value: string }[]
      ).map((r) => JSON.parse(r.value));
    const hasNext = events.length > limit;
    return {
      events: events.slice(0, limit),
      ...(hasNext
        ? {
            cursor: Buffer.from(
              JSON.stringify({
                type: t.type,
                id: t.id,
                version: v ?? null,
                revision,
                offset: offset + limit,
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  route('get', '/dataset-summary', (req, res) => {
    const t = target(req, 'dataset', str(req.query.dataset_id, 'dataset_id'), 'read');
    res.json({ total_records: store.datasetRows(t.id).length });
  });
  function summarizeExperiment(req: Request, id: string, comparison?: unknown) {
    const t = target(req, 'experiment', id, 'read');
    if (comparison != null) {
      target(req, 'experiment', str(comparison, 'comparison_experiment_id'), 'read');
      unsupported(
        'server-side baseline summaries; compare exported cases with verified scorer definitions',
      );
    }
    const e = store.require<Experiment>('experiment', t.id),
      cases = store.list<EvalCase>('case', t.projectId, t.id);
    const summary = aggregateExperiment(e, cases);
    const rootRows = rows(t).filter(
      (r) => !r.comment && (!Array.isArray(r.span_parents) || !r.span_parents.length),
    );
    if (
      rootRows.length &&
      rootRows.every((r) => record(r.metrics) && typeof r.metrics.end === 'number')
    )
      store.put('experiment', { ...summary, status: 'completed', finishedAt: now() }, t.projectId);
    return {
      scores: Object.fromEntries(
        Object.entries(summary.scores)
          .filter(([, value]) => value !== null)
          .map(([name, score]) => [name, { name, score, improvements: 0, regressions: 0 }]),
      ),
      metrics:
        summary.latencyMs === null
          ? {}
          : {
              latency: {
                name: 'latency',
                metric: summary.latencyMs / 1000,
                unit: 's',
                improvements: 0,
                regressions: 0,
              },
            },
    };
  }
  route('get', '/experiment-comparison2', (req, res) =>
    res.json(
      summarizeExperiment(
        req,
        str(req.query.experiment_id, 'experiment_id'),
        req.query.base_experiment_id,
      ),
    ),
  );

  // The pinned Python SDK uses the REST control plane rather than legacy registration.
  route('post', '/v1/project', (req, res) => {
    const body = object(req.body);
    exactKeys(body, ['name', 'org_name'], 'project registration');
    const p = resolveProject(
      req,
      {
        project_name: body.name,
        ...(body.org_name !== undefined ? { org_name: body.org_name } : {}),
      },
      'write',
    );
    res.json(projectInfo(p));
  });
  route('get', '/v1/project', (req, res) => {
    if (Object.keys(req.query).some((key) => !['project_name', 'org_name'].includes(key)))
      unsupported('project discovery filters');
    if (req.query.org_name !== undefined && req.query.org_name !== 'MindTrust')
      throw new HttpError(403, 'Unknown organization');
    res.json({
      objects: access
        .listProjects(req)
        .filter((p) => req.query.project_name === undefined || p.name === req.query.project_name)
        .map(projectInfo),
    });
  });
  route('get', '/v1/project/:id', (req, res) => {
    const p = store.project(str(req.params.id, 'id'));
    access.requireProject(req, p.id, 'read');
    res.json(projectInfo(p));
  });
  route('post', '/v1/dataset', (req, res) => {
    const body = object(req.body);
    exactKeys(body, ['project_id', 'name', 'description', 'metadata'], 'dataset registration');
    const { name, ...other } = body;
    res.json(registerDataset(req, { ...other, dataset_name: name }).dataset);
  });
  route('get', '/v1/dataset/:id', (req, res) => {
    const t = target(req, 'dataset', str(req.params.id, 'id'), 'read');
    res.json(datasetInfo(store.require<Dataset>('dataset', t.id)));
  });
  route('get', '/v1/dataset', (req, res) => {
    if (Object.keys(req.query).some((key) => !['project_id', 'dataset_name'].includes(key)))
      unsupported('dataset discovery filters');
    const projects = new Set(access.listProjects(req).map((p) => p.id));
    if (req.query.project_id !== undefined)
      access.requireProject(req, str(req.query.project_id, 'project_id'), 'read');
    res.json({
      objects: store
        .list<Dataset>('dataset')
        .filter(
          (d) =>
            projects.has(d.projectId) &&
            (req.query.project_id === undefined || d.projectId === req.query.project_id) &&
            (req.query.dataset_name === undefined || d.name === req.query.dataset_name),
        )
        .map(datasetInfo),
    });
  });
  route('post', '/v1/experiment', (req, res) => {
    const body = object(req.body);
    exactKeys(
      body,
      [
        'project_id',
        'name',
        'ensure_new',
        'description',
        'dataset_id',
        'dataset_version',
        'metadata',
        'tags',
        'repo_info',
        'ancestor_commits',
        'base_exp_id',
        'public',
      ],
      'experiment registration',
    );
    if (body.ensure_new !== undefined && typeof body.ensure_new !== 'boolean')
      throw new HttpError(400, 'ensure_new must be boolean');
    const { name, ensure_new, ...other } = body;
    const p = store.project(str(body.project_id, 'project_id'));
    access.requireProject(req, p.id, 'write');
    let chosenName = optionalString(name);
    if (
      ensure_new !== false &&
      chosenName &&
      store.list<Experiment>('experiment', p.id).some((e) => e.name === chosenName)
    )
      chosenName += `-${randomUUID().slice(0, 8)}`;
    res.json(
      registerExperiment(req, {
        ...other,
        ...(chosenName ? { experiment_name: chosenName } : {}),
        update: ensure_new === false,
      }).experiment,
    );
  });
  route('get', '/v1/experiment', (req, res) => {
    if (
      Object.keys(req.query).some(
        (key) => !['project_id', 'experiment_name', 'org_name'].includes(key),
      )
    )
      unsupported('experiment discovery filters');
    if (req.query.org_name !== undefined && req.query.org_name !== 'MindTrust')
      throw new HttpError(403, 'Unknown organization');
    const projects = new Set(access.listProjects(req).map((p) => p.id));
    if (req.query.project_id !== undefined)
      access.requireProject(req, str(req.query.project_id, 'project_id'), 'read');
    res.json({
      objects: store
        .list<Experiment>('experiment')
        .filter(
          (e) =>
            projects.has(e.projectId) &&
            (req.query.project_id === undefined || e.projectId === req.query.project_id) &&
            (req.query.experiment_name === undefined || e.name === req.query.experiment_name),
        )
        .map(experimentInfo),
    });
  });
  route('get', '/v1/dataset/:id/summarize', (req, res) => {
    const t = target(req, 'dataset', str(req.params.id, 'id'), 'read');
    if (Object.keys(req.query).some((key) => key !== 'summarize_data'))
      unsupported('dataset summary options');
    res.json({
      data_summary:
        req.query.summarize_data === 'false'
          ? null
          : { total_records: store.require<Dataset>('dataset', t.id).rowCount },
    });
  });
  route('get', '/v1/experiment/:id/summarize', (req, res) => {
    const t = target(req, 'experiment', str(req.params.id, 'id'), 'read');
    if (
      Object.keys(req.query).some(
        (key) => !['summarize_scores', 'comparison_experiment_id'].includes(key),
      )
    )
      unsupported('experiment summary options');
    res.json(
      req.query.summarize_scores === 'false'
        ? {}
        : summarizeExperiment(req, t.id, req.query.comparison_experiment_id),
    );
  });

  // JSONL/JSON migration can use the same validated transaction path as SDK writes.
  for (const type of ['dataset', 'experiment', 'project_logs'] as const) {
    route('post', `/v1/${type}/:id/feedback`, (req, res) => {
      const t = target(req, type, str(req.params.id, 'id'), 'write'),
        body = object(req.body);
      exactKeys(body, ['feedback'], 'feedback');
      if (!Array.isArray(body.feedback) || !body.feedback.length || body.feedback.length > 5000)
        throw new HttpError(400, 'Expected 1..5000 feedback items');
      const key = type === 'project_logs' ? 'project_id' : `${type}_id`;
      const events: Row[] = [];
      for (const item of body.feedback) {
        const f = object(item, 'feedback item');
        exactKeys(
          f,
          ['id', 'scores', 'expected', 'tags', 'comment', 'metadata', 'source'],
          'feedback',
        );
        const id = str(f.id, 'feedback.id');
        if (!rowById(t, id)) throw new HttpError(400, 'Feedback references a missing row');
        if (f.source != null && !['external', 'app', 'api'].includes(String(f.source)))
          throw new HttpError(400, 'Invalid feedback source');
        const audit = {
          _audit_source: f.source ?? 'external',
          ...(f.metadata == null
            ? {}
            : { _audit_metadata: object(f.metadata, 'feedback metadata') }),
        };
        const container = { [key]: t.id, ...(type === 'project_logs' ? { log_id: 'g' } : {}) };
        const updates: Row = {};
        for (const field of ['scores', 'expected', 'tags'])
          if (owns(f, field)) updates[field] = f[field];
        if (Object.keys(updates).length)
          events.push({ ...container, id, ...updates, ...audit, _is_merge: true });
        if (f.comment != null)
          events.push({
            ...container,
            id: randomUUID(),
            origin: { id },
            comment: { text: str(f.comment, 'comment') },
            created: now(),
            ...audit,
          });
      }
      if (events.length) ingest(req, events);
      res.json({ status: 'success' });
    });

    route('post', `/v1/${type}/:id/insert`, (req, res) => {
      const t = target(req, type, str(req.params.id, 'id'), 'write'),
        body = object(req.body);
      exactKeys(body, ['events'], 'insert');
      if (!Array.isArray(body.events)) throw new HttpError(400, 'events must be an array');
      const key = type === 'project_logs' ? 'project_id' : `${type}_id`;
      const events: Row[] = body.events.map((v) => {
        const row = object(v, 'event');
        if (row[key] !== undefined && row[key] !== t.id)
          throw new HttpError(400, 'Container ID disagrees with route');
        return { ...row, [key]: t.id, ...(type === 'project_logs' ? { log_id: 'g' } : {}) };
      });
      ingest(req, events);
      res.json({ row_ids: events.map((r) => r.id) });
    });
    for (const method of ['get', 'post'] as const)
      route(method, `/v1/${type}/:id/fetch`, (req, res) => {
        const t = target(req, type, str(req.params.id, 'id'), 'read');
        const query = method === 'get' ? req.query : object(req.body);
        if (Object.keys(query).some((k) => !['version', 'limit', 'cursor'].includes(k)))
          unsupported('fetch query options');
        res.json(fetchPage(t, query.version, query.limit, query.cursor));
      });
  }
  for (const path of [
    '/logs3/overflow',
    '/api/dataset_snapshot/register',
    '/api/dataset_snapshot/get',
    '/api/dataset_snapshot/patch_id',
    '/api/dataset_snapshot/delete_id',
  ])
    route('post', path, () => unsupported(path));
}
