import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { attachedSpans, bounded, duration } from './runtime.mjs';
export { processTask } from './runtime.mjs';

const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const message = (error) => (error instanceof Error ? error.message : String(error));
// A metered ancestor represents an aggregate; do not count its descendants twice.
const usageSpans = (spans, field) => {
  const byId = new Map(spans.map((span) => [span.id, span]));
  return spans.filter((span) => {
    if (field === 'costUsd' ? span.costUsd === null && span.kind !== 'llm' : span[field] <= 0)
      return false;
    let parent = byId.get(span.parentId);
    while (parent) {
      if (parent[field] > 0) return false;
      parent = byId.get(parent.parentId);
    }
    return true;
  });
};

/** A Node.js client. Call flush() before exiting to persist buffered traces. */
export class MindTrust {
  constructor({
    baseUrl = 'http://127.0.0.1:4310',
    apiKey,
    projectId,
    timeoutMs = 30_000,
    maxBufferedTraces = 1000,
  }) {
    if (!projectId) throw new Error('projectId is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4_294_967_295)
      throw new Error('timeoutMs must be a positive 32-bit integer');
    if (!Number.isSafeInteger(maxBufferedTraces) || maxBufferedTraces < 1)
      throw new Error('maxBufferedTraces must be a positive safe integer');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.timeoutMs = timeoutMs;
    this.maxBufferedTraces = maxBufferedTraces;
    this.pending = [];
    this.context = new AsyncLocalStorage();
    this.flushing = null;
    this.lastLoggingError = null;
  }

  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`MindTrust ${response.status}: ${result.error || response.statusText}`);
    return result;
  }

  /** Buffer a complete trace. Supplied IDs support safe re-delivery. */
  log(trace) {
    if (this.pending.length >= this.maxBufferedTraces)
      throw new Error('MindTrust trace buffer is full; await flush()');
    const item = json({ ...trace, id: trace.id || randomUUID() });
    this.pending.push(item);
    return item.id;
  }

  /** Nested trace() calls inherit their parent across async operations. */
  async trace(name, options, task) {
    return this._trace(name, options, task);
  }

  async _trace(name, options, task, captureTrace) {
    if (typeof options === 'function') {
      task = options;
      options = {};
    }
    if (typeof task !== 'function') throw new Error('trace requires a task function');
    options ||= {};
    const parent = this.context.getStore();
    const root = parent?.root || { id: randomUUID(), spans: [], closed: false };
    if (root.closed) throw new Error('Trace has already finished');
    if (root.spans.length >= 10000) throw new Error('A trace is limited to 10000 spans');
    const span = {
      id: randomUUID(),
      traceId: root.id,
      parentId: parent?.span.id || null,
      name,
      kind: options.kind || 'function',
      status: 'ok',
      startTime: new Date().toISOString(),
      endTime: '',
      input: json(options.input),
      output: null,
      metadata: json(options.metadata || {}),
      model: options.model || null,
      inputTokens: options.inputTokens || 0,
      outputTokens: options.outputTokens || 0,
      costUsd: options.costUsd ?? null,
    };
    root.spans.push(span);
    let explicitOutput = false;
    const handle = {
      id: span.id,
      traceId: root.id,
      addSpans: (records) => {
        if (root.closed) throw new Error('Trace has already finished');
        root.spans.push(...attachedSpans(json(records), root, span.id));
      },
      update: (fields) => {
        if (root.closed) return;
        if ('output' in fields) {
          span.output = json(fields.output);
          explicitOutput = true;
        }
        if ('input' in fields) span.input = json(fields.input);
        if (fields.metadata) span.metadata = { ...span.metadata, ...json(fields.metadata) };
        for (const field of ['model', 'inputTokens', 'outputTokens', 'costUsd', 'status']) {
          if (field in fields) span[field] = fields[field];
        }
      },
      trace: (childName, childOptions, childTask) => this.trace(childName, childOptions, childTask),
    };
    return this.context.run({ root, span }, async () => {
      let taskFailed = false;
      try {
        const output = await task(handle);
        if (!explicitOutput) span.output = json(output);
        return output;
      } catch (error) {
        taskFailed = true;
        if (!root.closed) {
          span.status = 'error';
          span.output = { error: message(error) };
        }
        throw error;
      } finally {
        if (!root.closed) span.endTime = new Date().toISOString();
        if (!parent) {
          root.closed = true;
          for (const child of root.spans) {
            if (!child.endTime) {
              child.endTime = span.endTime;
              child.status = 'error';
              child.output = { error: 'Parent evaluation finished before this span' };
            }
          }
          const metered = usageSpans(root.spans, 'costUsd');
          const costUsd =
            span.costUsd ??
            (metered.length && metered.every((s) => s.costUsd !== null)
              ? metered.reduce((total, s) => total + s.costUsd, 0)
              : null);
          const captured = {
            id: root.id,
            name: span.name,
            input: span.input,
            output: span.output,
            status: span.status,
            startTime: span.startTime,
            endTime: span.endTime,
            metadata: span.metadata,
            tags: options.tags || [],
            model: span.model || root.spans.find((s) => s.model)?.model || null,
            inputTokens: usageSpans(root.spans, 'inputTokens').reduce(
              (sum, s) => sum + s.inputTokens,
              0,
            ),
            outputTokens: usageSpans(root.spans, 'outputTokens').reduce(
              (sum, s) => sum + s.outputTokens,
              0,
            ),
            costUsd,
            spans: root.spans,
          };
          captureTrace?.(captured);
          try {
            this.log(captured);
          } catch (error) {
            this.lastLoggingError = error;
            // Instrumentation must never replace the application's original error.
            if (!taskFailed) throw error;
          }
        }
      }
    });
  }

  /** Sequential batches, retained on failure. Concurrent flush callers share work. */
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.pending.length) {
        const batch = this.pending.slice(0, 100);
        await this.request('/traces', { projectId: this.projectId, traces: batch });
        this.pending.splice(0, batch.length);
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  createDataset({ name, description = '', rows = [] }) {
    return this.request('/datasets', { projectId: this.projectId, name, description, rows });
  }

  getDataset(id, version) {
    return this.request(
      `/datasets/${encodeURIComponent(id)}${version == null ? '' : `?version=${version}`}`,
    );
  }

  insertDatasetRows(id, rows) {
    return this.request(`/datasets/${encodeURIComponent(id)}/rows`, { rows });
  }

  annotate({ targetId, targetType = 'trace', label, comment = '', expected = null }) {
    return this.request('/annotations', {
      projectId: this.projectId,
      targetType,
      targetId,
      label,
      comment,
      expected,
    });
  }

  /** Deliver a saved checkpoint, including its undelivered traces, without executing agent code. */
  async importEvaluation(checkpoint) {
    if (!checkpoint || checkpoint.projectId !== this.projectId)
      throw new Error('Evaluation checkpoint belongs to another project');
    const { pendingTraces = [], ...payload } = checkpoint;
    if (!Array.isArray(pendingTraces)) throw new Error('Invalid checkpoint traces');
    for (let offset = 0; offset < pendingTraces.length; offset += 100)
      await this.request('/traces', {
        projectId: this.projectId,
        traces: pendingTraces.slice(offset, offset + 100),
      });
    return this.request('/experiments/import', payload);
  }

  /** Execute trusted local functions. Persist traces and a retry-safe result import. */
  async evaluate({
    name,
    datasetId,
    datasetVersion,
    task,
    scorers = [],
    trials = 1,
    concurrency = 4,
    description = '',
    signal,
    caseTimeoutMs = 120_000,
    scorerTimeoutMs = 30_000,
    runId = randomUUID(),
    onCheckpoint,
  }) {
    const validName = (value) =>
      typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
    if (!validName(name) || !validName(runId))
      throw new Error('Evaluation name and runId require 1–200 characters');
    if (typeof description !== 'string' || description.length > 10000)
      throw new Error('Evaluation description exceeds 10000 characters');
    if (typeof task !== 'function') throw new Error('evaluate requires a task function');
    if (onCheckpoint !== undefined && typeof onCheckpoint !== 'function')
      throw new Error('onCheckpoint must be a function');
    duration(caseTimeoutMs, 'caseTimeoutMs');
    duration(scorerTimeoutMs, 'scorerTimeoutMs');
    if (!Number.isInteger(trials) || trials < 1 || trials > 10)
      throw new Error('trials must be between 1 and 10');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new Error('concurrency must be between 1 and 16');
    if (
      !Array.isArray(scorers) ||
      new Set(scorers.map((s) => s.name)).size !== scorers.length ||
      scorers.some((s) => !validName(s.name) || typeof s.score !== 'function')
    )
      throw new Error('Scorers require unique names (1–200 characters) and score functions');
    const dataset = await this.getDataset(datasetId, datasetVersion);
    if (dataset.dataset.projectId !== this.projectId)
      throw new Error('Dataset belongs to another project');
    const jobs = dataset.rows.flatMap((row) =>
      Array.from({ length: trials }, (_, trial) => ({ row, trial: trial + 1 })),
    );
    if (!jobs.length) throw new Error('Cannot evaluate an empty dataset');
    if (jobs.length > 10_000) throw new Error('An evaluation is limited to 10,000 cases');
    await this.flush();
    const createdAt = new Date().toISOString(),
      cases = new Array(jobs.length);
    let cursor = 0,
      workerFailure = null;
    const workerCount = Math.min(concurrency, jobs.length, this.maxBufferedTraces);
    const flushThreshold = Math.min(100, this.maxBufferedTraces - workerCount + 1);
    const checkpoint = () => ({
      runId,
      projectId: this.projectId,
      name,
      description,
      datasetId,
      datasetVersion: dataset.dataset.version,
      concurrency: workerCount,
      createdAt,
      finishedAt: new Date().toISOString(),
      cancelled: Boolean(signal?.aborted),
      plannedCases: jobs.length,
      interrupted: cases.filter(Boolean).length < jobs.length,
      cases: cases.filter(Boolean),
      pendingTraces: json(this.pending),
    });
    let saving = Promise.resolve();
    const save = (payload) => {
      if (!onCheckpoint) return Promise.resolve();
      // Serial writes keep a slower earlier checkpoint from overwriting a later one.
      saving = saving.catch(() => {}).then(() => onCheckpoint(json(payload)));
      return saving;
    };
    const workers = await Promise.allSettled(
      Array.from({ length: workerCount }, async () => {
        try {
          while (cursor < jobs.length && !workerFailure) {
            const index = cursor++,
              { row, trial } = jobs[index],
              start = performance.now();
            let output = null,
              error = null,
              traceId = null,
              captured = null;
            const scores = {},
              scoreErrors = {};
            const skipScores = () => {
              for (const scorer of scorers) {
                scores[scorer.name] = null;
                scoreErrors[scorer.name] = 'Task failed';
              }
            };
            try {
              // Evaluation cases must be independent roots even inside application instrumentation.
              await this.context.run(undefined, () =>
                this._trace(
                  `${name.slice(0, 100)} / case ${row.id}`.slice(0, 200),
                  {
                    input: row.input,
                    kind: 'agent',
                    metadata: {
                      datasetId,
                      datasetVersion: dataset.dataset.version,
                      rowId: row.id,
                      trial,
                      runId,
                      source: 'sdk-evaluation',
                    },
                  },
                  async (span) => {
                    traceId = span.traceId;
                    try {
                      output = json(
                        await bounded(
                          (caseSignal) =>
                            task(json(row.input), {
                              metadata: json(row.metadata || {}),
                              trial,
                              rowId: row.id,
                              span,
                              signal: caseSignal,
                            }),
                          caseTimeoutMs,
                          signal,
                          'Case',
                        ),
                      );
                      // Keep the agent output on the root; scorer spans retain their own results.
                      span.update({ output: json(output) });
                    } catch (cause) {
                      skipScores();
                      throw cause;
                    }
                    for (const scorer of scorers) {
                      try {
                        scores[scorer.name] = await span.trace(
                          `Score: ${scorer.name}`.slice(0, 200),
                          { kind: 'function', metadata: { scorer: scorer.name } },
                          async (scoreSpan) => {
                            const result = await bounded(
                              (scoreSignal) =>
                                scorer.score({
                                  input: json(row.input),
                                  output: json(output),
                                  expected:
                                    row.hasExpected === false || row.expected === undefined
                                      ? undefined
                                      : json(row.expected),
                                  metadata: json(row.metadata || {}),
                                  span: scoreSpan,
                                  signal: scoreSignal,
                                }),
                              scorerTimeoutMs,
                              signal,
                              'Scorer',
                            );
                            if (
                              typeof result !== 'number' ||
                              !Number.isFinite(result) ||
                              result < 0 ||
                              result > 1
                            )
                              throw new Error('A score must be a finite number from 0 to 1');
                            return result;
                          },
                        );
                      } catch (cause) {
                        scores[scorer.name] = null;
                        scoreErrors[scorer.name] = message(cause).slice(0, 10000);
                      }
                    }
                    return output;
                  },
                  (trace) => {
                    captured = trace;
                  },
                ),
              );
            } catch (cause) {
              error = message(cause).slice(0, 10000);
              skipScores();
            }
            cases[index] = {
              rowId: row.id,
              trial,
              input: row.input,
              expected: json(row.expected),
              output: json(output),
              scores,
              scoreErrors,
              latencyMs: performance.now() - start,
              error,
              traceId,
              costUsd: captured?.costUsd ?? null,
              inputTokens: captured?.inputTokens ?? 0,
              outputTokens: captured?.outputTokens ?? 0,
            };
            if (this.pending.length >= flushThreshold) {
              await save(checkpoint());
              await this.flush();
            }
          }
        } catch (cause) {
          workerFailure ||= cause;
          throw cause;
        }
      }),
    );
    const failedWorker = workers.find((result) => result.status === 'rejected');
    const payload = checkpoint();
    try {
      await save(payload);
      if (failedWorker) throw failedWorker.reason;
      await this.flush();
      const { pendingTraces: _, ...importBody } = payload;
      return await this.request('/experiments/import', importBody);
    } catch (cause) {
      // Preserve paid execution results for callers to retry without running the agent again.
      const failure = new Error(`Evaluation result delivery failed: ${message(cause)}`, { cause });
      failure.result = payload;
      throw failure;
    }
  }
}

export const scorers = {
  exactMatch: {
    name: 'Exact match',
    score: ({ output, expected }) =>
      expected === undefined ? 0 : Number(isDeepStrictEqual(output, expected)),
  },
  contains: {
    name: 'Contains',
    score: ({ output, expected }) => {
      if (output === undefined || expected === undefined) return 0;
      const printable = (value) =>
        typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
      const needle = printable(expected);
      return needle.length > 0 ? Number(printable(output).includes(needle)) : 0;
    },
  },
  jsonValid: {
    name: 'Valid JSON',
    score: ({ output }) => {
      try {
        if (typeof output !== 'string')
          return output !== null && typeof output === 'object' ? 1 : 0;
        JSON.parse(output);
        return 1;
      } catch {
        return 0;
      }
    },
  },
};
