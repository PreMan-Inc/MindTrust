export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Meta = Record<string, Json>;
export type Status = 'ok' | 'error';
export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}
export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  kind: 'agent' | 'llm' | 'tool' | 'retrieval' | 'function';
  status: Status;
  startTime: string;
  endTime: string;
  input: Json;
  output: Json;
  metadata: Meta;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}
export interface Trace {
  id: string;
  projectId: string;
  name: string;
  status: Status;
  startTime: string;
  endTime: string;
  input: Json;
  output: Json;
  tags: string[];
  metadata: Meta;
  model: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  spanCount: number;
}
export interface Annotation {
  id: string;
  projectId: string;
  targetType: 'trace' | 'case';
  targetId: string;
  label: 'correct' | 'incorrect' | 'needs_review';
  comment: string;
  expected: Json;
  createdAt: string;
}
export interface TraceDetail {
  trace: Trace;
  spans: Span[];
  annotations: Annotation[];
}
export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  description: string;
  version: number;
  rowCount: number;
  updatedAt: string;
}
export interface DatasetRow {
  id: string;
  input: Json;
  expected: Json;
  hasExpected?: boolean;
  metadata: Meta;
  tags: string[];
}
export interface DatasetVersion {
  version: number;
  rowCount: number;
  createdAt: string;
}
export interface DatasetDetail {
  dataset: Dataset;
  rows: DatasetRow[];
  versions: DatasetVersion[];
}
export interface Scorer {
  id: string;
  projectId: string;
  name: string;
  type: 'exact_match' | 'contains' | 'json_valid' | 'llm_judge';
  config: Meta;
  description: string;
  createdAt: string;
}
export interface Prompt {
  id: string;
  projectId: string;
  name: string;
  description: string;
  version: number;
  system: string;
  template: string;
  model: string;
  updatedAt: string;
}
export interface TaskConfig {
  type: 'echo' | 'template' | 'openai' | 'external';
  template?: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface Experiment {
  executionSource?: 'server' | 'sdk-import' | 'synthetic';
  id: string;
  projectId: string;
  name: string;
  description: string;
  datasetId: string;
  datasetVersion: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  task: TaskConfig;
  scorerIds: string[];
  trials: number;
  concurrency: number;
  totalCases: number;
  completedCases: number;
  scores: Record<string, number | null>;
  latencyMs: number | null;
  costUsd: number | null;
  unknownCostCount: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface EvalCase {
  id: string;
  experimentId: string;
  rowId: string;
  trial: number;
  input: Json;
  expected: Json;
  output: Json;
  scores: Record<string, number | null>;
  scoreErrors: Record<string, string>;
  /** Judge reasons, keyed like scores. */
  scoreExplanations?: Record<string, string>;
  /** Judge token usage, keyed like scores; separate from the task's own tokens. */
  scoreUsage?: Record<string, { inputTokens: number; outputTokens: number }>;
  error: string | null;
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  traceId: string | null;
}
export interface ExperimentDetail {
  experiment: Experiment;
  cases: EvalCase[];
  scorers: Scorer[];
}
export interface ComparisonRow {
  rowId: string;
  trial: number;
  input: Json;
  baseline: EvalCase | null;
  candidate: EvalCase | null;
  deltas: Record<string, number | null>;
}
export interface Comparison {
  baseline: Experiment;
  candidate: Experiment;
  rows: ComparisonRow[];
  deltas: Record<string, number | null>;
  comparable: boolean;
  warning: string | null;
  /** Rows where any matched score dropped. */
  regressions?: number;
  /** Rows where a matched score rose and none dropped. */
  improvements?: number;
}
export interface GateResult {
  decision: 'pass' | 'fail' | 'not_comparable' | 'incomplete';
  reasons: string[];
  experimentId: string;
  comparison: {
    baselineId: string;
    comparable: boolean;
    regressions: number;
    improvements: number;
    deltas: Record<string, number | null>;
  } | null;
}
export interface Overview {
  traceCount: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  knownCostUsd: number;
  unknownCostCount: number;
  datasetCount: number;
  experimentCount: number;
  series: { date: string; traces: number; errors: number; costUsd: number; tokens: number }[];
  models: { model: string; traces: number; tokens: number; costUsd: number }[];
  recentTraces: Trace[];
  recentExperiments: Experiment[];
}
export interface ServerInfo {
  version: string;
  authEnabled: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string;
  storage: string;
  demoSeeded: boolean;
}
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}
