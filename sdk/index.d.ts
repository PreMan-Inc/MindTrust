type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Meta = Record<string, Json>;
export interface SpanOptions {
  input?: Json;
  kind?: 'agent' | 'llm' | 'tool' | 'retrieval' | 'function';
  metadata?: Meta;
  tags?: string[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}
export interface SpanHandle {
  id: string;
  traceId: string;
  update(fields: Partial<SpanOptions> & { output?: Json; status?: 'ok' | 'error' }): void;
  trace<T>(
    name: string,
    options: SpanOptions,
    task: (span: SpanHandle) => T | Promise<T>,
  ): Promise<T>;
  trace<T>(name: string, task: (span: SpanHandle) => T | Promise<T>): Promise<T>;
}
export interface Scorer {
  name: string;
  score(args: {
    input: Json;
    output: Json;
    expected: Json | undefined;
    metadata: Meta;
  }): number | Promise<number>;
}
export class MindTrust {
  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    projectId: string;
    timeoutMs?: number;
    maxBufferedTraces?: number;
  });
  projectId: string;
  /** Most recent buffer failure, including one suppressed to preserve a task error. */
  lastLoggingError: Error | null;
  request(path: string, body?: unknown, method?: string): Promise<any>;
  log(trace: Record<string, unknown> & { name: string }): string;
  trace<T>(
    name: string,
    options: SpanOptions,
    task: (span: SpanHandle) => T | Promise<T>,
  ): Promise<T>;
  trace<T>(name: string, task: (span: SpanHandle) => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
  createDataset(options: {
    name: string;
    description?: string;
    rows?: { id?: string; input: Json; expected?: Json; tags?: string[]; metadata?: Meta }[];
  }): Promise<any>;
  getDataset(id: string, version?: number): Promise<any>;
  insertDatasetRows(id: string, rows: unknown[]): Promise<any>;
  annotate(options: {
    targetId: string;
    targetType?: 'trace' | 'case';
    label: 'correct' | 'incorrect' | 'needs_review';
    comment?: string;
    expected?: Json;
  }): Promise<any>;
  /** Trials are numbered from 1. Each run pins the dataset revision returned at startup. */
  evaluate(options: {
    name: string;
    datasetId: string;
    datasetVersion?: number;
    task: (
      input: Json,
      context: { metadata: Meta; trial: number; span: SpanHandle },
    ) => Json | Promise<Json>;
    scorers?: Scorer[];
    trials?: number;
    concurrency?: number;
    description?: string;
  }): Promise<any>;
}
/** Builtins match the backend: missing expected scores 0; Contains stringifies JSON; Valid JSON accepts objects/arrays or parseable JSON text. */
export const scorers: { exactMatch: Scorer; contains: Scorer; jsonValid: Scorer };
