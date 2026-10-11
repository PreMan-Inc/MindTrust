import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  Annotation,
  ApiKey,
  Dataset,
  DatasetRow,
  DatasetVersion,
  EvalCase,
  Experiment,
  Meta,
  Overview,
  Project,
  Prompt,
  Scorer,
  Span,
  Trace,
} from '../shared/types.ts';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Kind =
  | 'project'
  | 'trace'
  | 'span'
  | 'annotation'
  | 'dataset'
  | 'scorer'
  | 'experiment'
  | 'case'
  | 'prompt';
export interface ExperimentSnapshot {
  rows: DatasetRow[];
  scorers: Scorer[];
}
export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const existingVersion = (
      this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version;
    if (existingVersion > 3) {
      this.db.close();
      throw new Error(
        'Database was created by a newer MindTrust version; refusing an unsafe downgrade',
      );
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, parent_id TEXT, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_project ON records(kind,project_id);
      CREATE INDEX IF NOT EXISTS records_parent ON records(kind,parent_id);
      CREATE INDEX IF NOT EXISTS traces_time ON records(project_id,json_extract(value,'$.startTime') DESC,id) WHERE kind='trace';
      CREATE INDEX IF NOT EXISTS traces_status_time ON records(project_id,json_extract(value,'$.status'),json_extract(value,'$.startTime') DESC,id) WHERE kind='trace';
      CREATE TABLE IF NOT EXISTS dataset_versions (dataset_id TEXT NOT NULL, version INTEGER NOT NULL, rows_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(dataset_id,version));
      CREATE TABLE IF NOT EXISTS prompt_versions (prompt_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(prompt_id,version));
      CREATE TABLE IF NOT EXISTS experiment_snapshots (experiment_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trace_sources (trace_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version < 2)
      this.transaction(() => {
        // OTLP span IDs are unique within a trace, not globally. Keep the original
        // IDs in JSON and use the trace/span pair only as the internal storage key.
        this.db.exec("UPDATE records SET id='migration:' || rowid WHERE kind='span'");
        this.db.exec(
          "UPDATE records SET id=json_array(parent_id,json_extract(value,'$.id')) WHERE kind='span'",
        );
        this.db.exec('PRAGMA user_version=2');
      });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get<T>(kind: Kind, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  require<T>(kind: Kind, id: string): T {
    const value = this.get<T>(kind, id);
    if (!value) throw new HttpError(404, `${kind[0].toUpperCase()}${kind.slice(1)} not found`);
    return value;
  }
  list<T>(kind: Kind, projectId?: string, parentId?: string): T[] {
    let sql = 'SELECT value FROM records WHERE kind=?';
    const args: string[] = [kind];
    if (projectId) {
      sql += ' AND project_id=?';
      args.push(projectId);
    }
    if (parentId) {
      sql += ' AND parent_id=?';
      args.push(parentId);
    }
    sql += ' ORDER BY rowid DESC';
    return (this.db.prepare(sql).all(...args) as { value: string }[]).map((row) =>
      JSON.parse(row.value),
    );
  }
  put<T extends { id: string }>(kind: Kind, value: T, projectId: string, parentId?: string) {
    if (kind === 'span' && !parentId) throw new Error('Span storage requires its trace ID');
    const recordId = kind === 'span' ? JSON.stringify([parentId, value.id]) : value.id;
    const previous = this.db
      .prepare('SELECT project_id FROM records WHERE kind=? AND id=?')
      .get(kind, recordId) as { project_id: string } | undefined;
    if (previous && previous.project_id !== projectId)
      throw new HttpError(409, `${kind} ID already belongs to a different project`);
    this.db
      .prepare(
        'INSERT INTO records(kind,id,project_id,parent_id,value) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,parent_id=excluded.parent_id',
      )
      .run(kind, recordId, projectId, parentId ?? null, JSON.stringify(value));
    return value;
  }
  project(id: string) {
    return this.require<Project>('project', id);
  }
  datasetRows(id: string, version?: number): DatasetRow[] {
    const dataset = this.require<Dataset>('dataset', id);
    const row = this.db
      .prepare('SELECT rows_json FROM dataset_versions WHERE dataset_id=? AND version=?')
      .get(id, version ?? dataset.version) as { rows_json: string } | undefined;
    if (!row) throw new HttpError(404, 'Dataset version not found');
    return JSON.parse(row.rows_json);
  }
  datasetVersions(id: string): DatasetVersion[] {
    return (
      this.db
        .prepare(
          'SELECT version, json_array_length(rows_json) AS row_count, created_at FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC',
        )
        .all(id) as { version: number; row_count: number; created_at: string }[]
    ).map((row) => ({
      version: row.version,
      rowCount: row.row_count,
      createdAt: row.created_at,
    }));
  }
  saveDatasetSnapshot(dataset: Dataset, rows: DatasetRow[]) {
    this.db
      .prepare(
        'INSERT INTO dataset_versions(dataset_id,version,rows_json,created_at) VALUES(?,?,?,?)',
      )
      .run(dataset.id, dataset.version, JSON.stringify(rows), dataset.updatedAt);
    this.put('dataset', dataset, dataset.projectId);
  }
  datasetDetail(id: string, version?: number) {
    const dataset = this.require<Dataset>('dataset', id);
    const rows = this.datasetRows(id, version);
    const versions = this.datasetVersions(id);
    const v = versions.find((v) => v.version === (version ?? dataset.version))!;
    return {
      dataset: { ...dataset, version: v.version, rowCount: rows.length, updatedAt: v.createdAt },
      rows,
      versions,
    };
  }
  savePromptVersion(prompt: Prompt) {
    this.db
      .prepare('INSERT INTO prompt_versions(prompt_id,version,value) VALUES(?,?,?)')
      .run(prompt.id, prompt.version, JSON.stringify(prompt));
    this.put('prompt', prompt, prompt.projectId);
  }
  promptVersions(id: string): Prompt[] {
    return (
      this.db
        .prepare('SELECT value FROM prompt_versions WHERE prompt_id=? ORDER BY version DESC')
        .all(id) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  saveExperiment(experiment: Experiment, snapshot: ExperimentSnapshot) {
    this.put('experiment', experiment, experiment.projectId);
    this.db
      .prepare(
        'INSERT INTO experiment_snapshots(experiment_id,value) VALUES(?,?) ON CONFLICT(experiment_id) DO UPDATE SET value=excluded.value',
      )
      .run(experiment.id, JSON.stringify(snapshot));
  }
  experimentSnapshot(id: string): ExperimentSnapshot {
    const row = this.db
      .prepare('SELECT value FROM experiment_snapshots WHERE experiment_id=?')
      .get(id) as { value: string } | undefined;
    if (!row) throw new HttpError(404, 'Experiment snapshot not found');
    return JSON.parse(row.value);
  }
  experimentDetail(id: string) {
    return {
      experiment: this.require<Experiment>('experiment', id),
      cases: this.list<EvalCase>('case', undefined, id).sort(
        (a, b) => a.rowId.localeCompare(b.rowId) || a.trial - b.trial,
      ),
      scorers: this.experimentSnapshot(id).scorers,
    };
  }
  traceDetail(id: string) {
    const trace = this.require<Trace>('trace', id);
    return {
      trace,
      spans: this.list<Span>('span', undefined, id).sort((a, b) =>
        a.startTime.localeCompare(b.startTime),
      ),
      annotations: this.list<Annotation>('annotation', trace.projectId, id).filter(
        (a) => a.targetType === 'trace' && a.targetId === id,
      ),
    };
  }
  traceSources(id: string): Meta {
    const row = this.db.prepare('SELECT value FROM trace_sources WHERE trace_id=?').get(id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : {};
  }
  setTraceSources(id: string, sources: Meta) {
    this.db
      .prepare(
        'INSERT INTO trace_sources(trace_id,value) VALUES(?,?) ON CONFLICT(trace_id) DO UPDATE SET value=excluded.value',
      )
      .run(id, JSON.stringify(sources));
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  keys(): ApiKey[] {
    return (
      this.db
        .prepare('SELECT id,name,prefix,created_at FROM api_keys ORDER BY created_at DESC')
        .all() as { id: string; name: string; prefix: string; created_at: string }[]
    ).map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at }));
  }
  queryTraces(
    projectId: string,
    options: { search?: string; status?: string; limit: number; offset: number },
  ): { items: Trace[]; total: number } {
    let where = "kind='trace' AND project_id=?";
    const args: (string | number)[] = [projectId];
    if (options.status) {
      where += " AND json_extract(value,'$.status')=?";
      args.push(options.status);
    }
    if (options.search) {
      // Parameterized substring matching preserves JSON search semantics while
      // avoiding materializing every trace in the application process.
      where +=
        " AND instr(lower(json_array(json_extract(value,'$.name'),json_extract(value,'$.input'),json_extract(value,'$.output'),json_extract(value,'$.metadata'),json_extract(value,'$.tags'))),lower(?))>0";
      args.push(options.search);
    }
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM records WHERE ${where}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT value FROM records WHERE ${where} ORDER BY json_extract(value,'$.startTime') DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, options.limit, options.offset) as { value: string }[];
    return { total, items: rows.map((r) => JSON.parse(r.value)) };
  }
  overview(projectId: string): Overview {
    const totals = this.db
      .prepare(
        `SELECT count(*) AS traceCount,
      coalesce(sum(json_extract(value,'$.status')='error'),0) AS errorCount,
      coalesce(sum(json_extract(value,'$.inputTokens')+json_extract(value,'$.outputTokens')),0) AS totalTokens,
      coalesce(sum(json_extract(value,'$.costUsd')),0) AS knownCostUsd,
      coalesce(sum(json_extract(value,'$.costUsd') IS NULL),0) AS unknownCostCount
      FROM records WHERE kind='trace' AND project_id=?`,
      )
      .get(projectId) as Pick<
      Overview,
      'traceCount' | 'errorCount' | 'totalTokens' | 'knownCostUsd' | 'unknownCostCount'
    >;
    const quantile = (p: number) =>
      totals.traceCount
        ? (
            this.db
              .prepare(
                "SELECT json_extract(value,'$.latencyMs') AS n FROM records WHERE kind='trace' AND project_id=? ORDER BY n LIMIT 1 OFFSET ?",
              )
              .get(projectId, Math.max(0, Math.ceil(totals.traceCount * p) - 1)) as { n: number }
          ).n
        : 0;
    const count = (kind: string) =>
      (
        this.db
          .prepare('SELECT count(*) AS n FROM records WHERE kind=? AND project_id=?')
          .get(kind, projectId) as { n: number }
      ).n;
    const series = this.db
      .prepare(
        `SELECT substr(json_extract(value,'$.startTime'),1,10) AS date,count(*) AS traces,
      coalesce(sum(json_extract(value,'$.status')='error'),0) AS errors,coalesce(sum(json_extract(value,'$.costUsd')),0) AS costUsd,
      coalesce(sum(json_extract(value,'$.inputTokens')+json_extract(value,'$.outputTokens')),0) AS tokens
      FROM records WHERE kind='trace' AND project_id=? GROUP BY date ORDER BY date`,
      )
      .all(projectId) as Overview['series'];
    const models = this.db
      .prepare(
        `SELECT coalesce(json_extract(value,'$.model'),'Unspecified') AS model,count(*) AS traces,
      coalesce(sum(json_extract(value,'$.inputTokens')+json_extract(value,'$.outputTokens')),0) AS tokens,coalesce(sum(json_extract(value,'$.costUsd')),0) AS costUsd
      FROM records WHERE kind='trace' AND project_id=? GROUP BY model ORDER BY traces DESC`,
      )
      .all(projectId) as Overview['models'];
    const recentExperiments = (
      this.db
        .prepare(
          "SELECT value FROM records WHERE kind='experiment' AND project_id=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 5",
        )
        .all(projectId) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
    return {
      ...totals,
      errorRate: totals.traceCount ? totals.errorCount / totals.traceCount : 0,
      p50LatencyMs: quantile(0.5),
      p95LatencyMs: quantile(0.95),
      datasetCount: count('dataset'),
      experimentCount: count('experiment'),
      series,
      models,
      recentTraces: this.queryTraces(projectId, { limit: 8, offset: 0 }).items,
      recentExperiments,
    };
  }
  health() {
    if (this.closed) return false;
    try {
      return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    } catch {
      return false;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
