import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { EvalCase, Experiment, Json, Scorer, TaskConfig, Trace } from '../shared/types.ts';
import { HttpError, Store } from './store.ts';

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function selected(value: unknown, path: unknown): unknown {
  if (typeof path !== 'string' || !path) return value;
  for (const part of path.split('.')) {
    if (
      part === '__proto__' ||
      part === 'prototype' ||
      part === 'constructor' ||
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function printable(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}
export function renderTemplate(template: string, input: Json): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, raw: string) => {
    const path = raw.trim();
    if (!/^input(?:\.[\w-]+)*$/.test(path))
      throw new HttpError(400, `Unknown template variable: ${path}`);
    const value = path === 'input' ? input : selected(input, path.slice(6));
    if (value === undefined) throw new HttpError(400, `Missing template variable: ${path}`);
    return printable(value);
  });
}
export function scoreOutput(scorer: Scorer, output: Json, expected: Json): number {
  const actual = selected(output, scorer.config.outputPath),
    wanted = selected(expected, scorer.config.expectedPath);
  if (actual === undefined) return 0;
  if (scorer.type === 'json_valid') {
    if (typeof actual === 'string') {
      try {
        JSON.parse(actual);
        return 1;
      } catch {
        return 0;
      }
    }
    return actual !== null && typeof actual === 'object' ? 1 : 0;
  }
  if (wanted === undefined) return 0;
  if (scorer.type === 'exact_match') return stableJson(actual) === stableJson(wanted) ? 1 : 0;
  // Empty expected content is not meaningful evidence of inclusion.
  const needle = printable(wanted);
  return needle.length > 0 && printable(actual).includes(needle) ? 1 : 0;
}
export interface Provider {
  baseUrl: string;
  apiKey?: string;
}
export interface TaskResult {
  output: Json;
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}
export async function executeTask(
  task: TaskConfig,
  input: Json,
  provider: Provider,
  signal?: AbortSignal,
): Promise<TaskResult> {
  const started = performance.now();
  let output: Json;
  let inputTokens = 0,
    outputTokens = 0;
  if (signal?.aborted) throw new Error('Run cancelled');
  if (task.type === 'external')
    throw new HttpError(422, 'Externally executed tasks must be rerun by their SDK client');
  if (task.type === 'echo') output = input;
  else if (task.type === 'template') output = renderTemplate(task.template ?? '', input);
  else {
    if (!provider.apiKey)
      throw new HttpError(503, 'No model provider configured. Set OPENAI_API_KEY on the server.');
    const timeout = AbortSignal.timeout(30000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({
          model: task.model ?? 'gpt-4.1-mini',
          messages: [
            ...(task.system ? [{ role: 'system', content: task.system }] : []),
            {
              role: 'user',
              content: task.template ? renderTemplate(task.template, input) : printable(input),
            },
          ],
          ...(task.temperature !== undefined ? { temperature: task.temperature } : {}),
          max_tokens: task.maxTokens ?? 1024,
        }),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('Run cancelled');
      if (timeout.aborted) throw new Error('Model provider timed out after 30 seconds');
      throw new Error('Unable to connect to model provider');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, `Model provider returned HTTP ${response.status}`);
    }
    // Bound provider responses independently of the public request body limit.
    const reader = response.body?.getReader();
    let text = '';
    let size = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Model provider response exceeded 2 MB');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Model provider returned invalid JSON');
    }
    if (!payload || typeof payload !== 'object')
      throw new Error('Model provider returned an invalid response');
    const data = payload as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string')
      throw new Error('Model provider response has no text completion');
    output = content;
    const validToken = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    inputTokens = validToken(data.usage?.prompt_tokens);
    outputTokens = validToken(data.usage?.completion_tokens);
  }
  return {
    output,
    latencyMs: Math.max(0, performance.now() - started),
    costUsd: task.type === 'openai' ? null : 0,
    inputTokens,
    outputTokens,
  };
}
export function aggregateExperiment(experiment: Experiment, cases: EvalCase[]): Experiment {
  const names = new Set([...experiment.scorerIds, ...cases.flatMap((c) => Object.keys(c.scores))]);
  const scores: Record<string, number | null> = {};
  for (const name of names) {
    const values = cases
      .filter((c) => !c.error)
      .map((c) => c.scores[name])
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    scores[name] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
  const priced = cases.filter((c) => c.costUsd !== null);
  const unknown = cases.length - priced.length;
  return {
    ...experiment,
    completedCases: cases.length,
    scores,
    latencyMs: cases.length ? cases.reduce((sum, c) => sum + c.latencyMs, 0) / cases.length : null,
    costUsd: unknown ? null : priced.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
    unknownCostCount: unknown,
  };
}
export function taskTrace(
  store: Store,
  projectId: string,
  name: string,
  input: Json,
  result: TaskResult,
  task: TaskConfig,
  metadata: Record<string, Json> = {},
): string {
  const end = Date.now();
  const id = randomUUID();
  const trace: Trace = {
    id,
    projectId,
    name,
    status: 'ok',
    startTime: new Date(end - result.latencyMs).toISOString(),
    endTime: new Date(end).toISOString(),
    input,
    output: result.output,
    tags: ['evaluation'],
    metadata: { ...metadata, taskType: task.type },
    model: task.type === 'openai' ? (task.model ?? 'gpt-4.1-mini') : null,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    spanCount: 0,
  };
  trace.spanCount = 1;
  store.put('trace', trace, projectId);
  store.put(
    'span',
    {
      id: randomUUID(),
      traceId: id,
      parentId: null,
      name,
      kind: task.type === 'openai' ? 'llm' : 'function',
      status: 'ok',
      startTime: trace.startTime,
      endTime: trace.endTime,
      input,
      output: result.output,
      metadata: trace.metadata,
      model: trace.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    },
    projectId,
    id,
  );
  store.setTraceSources(id, {
    costUsd: true,
    inputTokens: true,
    outputTokens: true,
    startTime: true,
    endTime: true,
  });
  return id;
}

export class EvaluationQueue {
  private jobs = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private closing = false;
  private occupied = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private store: Store,
    private provider: Provider,
  ) {}
  resume() {
    // Read only recoverable IDs, not every historical experiment payload.
    const resumable = this.store.db
      .prepare(
        "SELECT id FROM records WHERE kind='experiment' AND json_extract(value,'$.status') IN ('queued','running') AND COALESCE(json_extract(value,'$.task.type'),'')<>'external' AND COALESCE(json_extract(value,'$.executionSource'),'')<>'sdk-import'",
      )
      .all() as { id: string }[];
    for (const experiment of resumable) this.pending.add(experiment.id);
    this.pump();
  }
  stats() {
    return {
      activeJobs: this.jobs.size,
      queuedJobs: this.pending.size,
      activeTasks: this.occupied,
      waitingTasks: this.waiters.length,
      maxActiveJobs: 4,
      maxActiveTasks: 16,
      maxQueuedJobs: 1000,
      stopping: this.closing,
    };
  }
  assertCapacity() {
    if (this.closing) throw new HttpError(503, 'Evaluation service is draining; retry shortly');
    if (this.pending.size >= 1000)
      throw new HttpError(429, 'Evaluation queue is full; retry after existing runs finish');
  }
  enqueue(id: string) {
    if (this.closing || this.jobs.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    this.pump();
  }
  private pump() {
    while (!this.closing && this.jobs.size < 4 && this.pending.size) {
      const id = this.pending.values().next().value!;
      this.pending.delete(id);
      this.start(id);
    }
  }
  private start(id: string) {
    const job = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(id))
      .catch((error) => {
        if (this.closing) return;
        const experiment = this.store.get<Experiment>('experiment', id);
        if (experiment && experiment.status !== 'cancelled')
          this.store.put(
            'experiment',
            {
              ...experiment,
              status: 'failed' as const,
              error: 'Evaluation could not finish',
              finishedAt: new Date().toISOString(),
            },
            experiment.projectId,
          );
        console.error(
          'Evaluation worker failed:',
          error instanceof Error ? error.message : 'Unknown error',
        );
      })
      .finally(() => {
        this.jobs.delete(id);
        this.controllers.delete(id);
        this.pump();
      });
    this.jobs.set(id, job);
  }
  private async slot() {
    if (this.occupied >= 16) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.occupied++;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.occupied--;
    };
  }
  private async run(id: string) {
    if (this.closing) return;
    let experiment = this.store.require<Experiment>('experiment', id);
    if (experiment.status === 'cancelled' || experiment.status === 'completed') return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const snapshot = this.store.experimentSnapshot(id);
    experiment = { ...experiment, status: 'running' };
    this.store.put('experiment', experiment, experiment.projectId);
    const previousCases = this.store.list<EvalCase>('case', undefined, id);
    const existing = new Set(previousCases.map((c) => `${c.rowId}:${c.trial}`));
    const scoreTotals = new Map<string, { sum: number; count: number }>();
    let completedCount = 0,
      latencySum = 0,
      knownCost = 0,
      unknownCost = 0,
      failedCount = 0;
    const countCase = (c: EvalCase) => {
      completedCount++;
      latencySum += c.latencyMs;
      if (c.costUsd === null) unknownCost++;
      else knownCost += c.costUsd;
      if (c.error) failedCount++;
      else
        for (const [name, score] of Object.entries(c.scores)) {
          if (score === null) continue;
          const totals = scoreTotals.get(name) ?? { sum: 0, count: 0 };
          totals.sum += score;
          totals.count++;
          scoreTotals.set(name, totals);
        }
    };
    previousCases.forEach(countCase);
    const progress = (current: Experiment): Experiment => ({
      ...current,
      completedCases: completedCount,
      scores: Object.fromEntries(
        current.scorerIds.map((name) => {
          const totals = scoreTotals.get(name);
          return [name, totals?.count ? totals.sum / totals.count : null];
        }),
      ),
      latencyMs: completedCount ? latencySum / completedCount : null,
      costUsd: unknownCost ? null : knownCost,
      unknownCostCount: unknownCost,
    });
    const totalTasks = snapshot.rows.length * experiment.trials;
    let cursor = 0;
    const worker = async () => {
      while (cursor < totalTasks && !controller.signal.aborted && !this.closing) {
        const taskIndex = cursor++;
        const item = {
          row: snapshot.rows[Math.floor(taskIndex / experiment.trials)],
          trial: (taskIndex % experiment.trials) + 1,
        };
        if (existing.has(`${item.row.id}:${item.trial}`)) continue;
        const release = await this.slot();
        try {
          if (controller.signal.aborted || this.closing) break;
          const started = performance.now();
          const c: EvalCase = {
            id: randomUUID(),
            experimentId: id,
            rowId: item.row.id,
            trial: item.trial,
            input: item.row.input,
            expected: item.row.expected,
            output: null,
            scores: Object.fromEntries(snapshot.scorers.map((s) => [s.id, null])),
            scoreErrors: {},
            error: null,
            latencyMs: 0,
            costUsd: null,
            inputTokens: 0,
            outputTokens: 0,
            traceId: null,
          };
          try {
            const result = await executeTask(
              experiment.task,
              item.row.input,
              this.provider,
              controller.signal,
            );
            Object.assign(c, result);
            for (const scorer of snapshot.scorers) {
              if (item.row.hasExpected === false && scorer.type !== 'json_valid') {
                c.scoreErrors[scorer.id] = 'Dataset row has no expected value';
                continue;
              }
              try {
                c.scores[scorer.id] = scoreOutput(scorer, result.output, item.row.expected);
              } catch {
                c.scoreErrors[scorer.id] = 'Scorer failed';
              }
            }
            if (!this.closing && !controller.signal.aborted)
              c.traceId = taskTrace(
                this.store,
                experiment.projectId,
                `${experiment.name} · ${item.row.id}`,
                item.row.input,
                result,
                experiment.task,
                {
                  experimentId: id,
                  rowId: item.row.id,
                  trial: item.trial,
                  ...(item.row.metadata.synthetic ? { synthetic: true } : {}),
                },
              );
          } catch (error) {
            c.error = error instanceof Error ? error.message : 'Task failed';
            c.latencyMs = performance.now() - started;
          }
          if (this.closing || controller.signal.aborted) break;
          this.store.transaction(() => {
            this.store.put('case', c, experiment.projectId, id);
            countCase(c);
            const current = this.store.require<Experiment>('experiment', id);
            this.store.put('experiment', progress(current), experiment.projectId);
          });
        } finally {
          release();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(experiment.concurrency, Math.max(totalTasks, 1)) }, worker),
    );
    if (this.closing) return;
    const current = this.store.require<Experiment>('experiment', id);
    if (current.status === 'cancelled') return;
    const allFailed = completedCount > 0 && failedCount === completedCount;
    this.store.put(
      'experiment',
      {
        ...progress(current),
        status: allFailed ? 'failed' : 'completed',
        error: allFailed ? 'All evaluation cases failed; inspect the case errors.' : null,
        finishedAt: new Date().toISOString(),
      },
      experiment.projectId,
    );
  }
  cancel(id: string) {
    const experiment = this.store.require<Experiment>('experiment', id);
    if (
      experiment.status === 'completed' ||
      experiment.status === 'failed' ||
      experiment.status === 'cancelled'
    )
      return experiment;
    this.controllers.get(id)?.abort();
    this.pending.delete(id);
    return this.store.put(
      'experiment',
      { ...experiment, status: 'cancelled' as const, finishedAt: new Date().toISOString() },
      experiment.projectId,
    );
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.jobs.values());
  }
}
