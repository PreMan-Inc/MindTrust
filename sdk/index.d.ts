type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Meta = Record<string, Json>;
export interface CompletedSpan extends SpanOptions {
  id: string;
  parentId?: string | null;
  name: string;
  status?: 'ok' | 'error';
  startTime: string;
  endTime: string;
  output?: Json;
}
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
  /** Attach a complete span tree from Python or another runtime; IDs are remapped. */
  addSpans(spans: CompletedSpan[]): void;
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
    /** Supplied by evaluate; optional for direct calls to a scorer. */
    span?: SpanHandle;
    signal?: AbortSignal;
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
  importEvaluation(checkpoint: Record<string, any>): Promise<any>;
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
      context: {
        metadata: Meta;
        trial: number;
        rowId: string;
        span: SpanHandle;
        signal: AbortSignal;
      },
    ) => Json | Promise<Json>;
    scorers?: Scorer[];
    trials?: number;
    concurrency?: number;
    description?: string;
    signal?: AbortSignal;
    /** In-process callbacks must honor signal to stop side effects. */
    caseTimeoutMs?: number;
    scorerTimeoutMs?: number;
    runId?: string;
    /** Serialized before trace batches and final delivery; includes completed cases and undelivered traces. */
    onCheckpoint?: (payload: Record<string, any>) => void | Promise<void>;
  }): Promise<any>;
}
/** Execute trusted local code with bounded I/O and process-group termination on POSIX. Not a security sandbox. */
export function processTask(options: {
  command: string;
  args?: string[];
  cwd?: string;
  /** Only basic OS variables are inherited; provide credentials explicitly. */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): (
  input: Json,
  context: { metadata: Meta; trial: number; span: SpanHandle; signal: AbortSignal },
) => Promise<Json>;
/** Builtins match the backend: missing expected scores 0; Contains stringifies JSON; Valid JSON accepts objects/arrays or parseable JSON text. */
type BuiltinScorer = {
  name: string;
  score(args: Omit<Parameters<Scorer['score']>[0], 'span' | 'signal'>): number;
};
export const scorers: {
  exactMatch: BuiltinScorer;
  contains: BuiltinScorer;
  jsonValid: BuiltinScorer;
};
