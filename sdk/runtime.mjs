import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function duration(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)
    throw new Error(`${name} must be a positive 32-bit integer`);
}

export async function bounded(task, milliseconds, signal, label) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error(`${label} timed out after ${milliseconds} ms`)),
    milliseconds,
  );
  const work = Promise.resolve().then(() => {
    combined.throwIfAborted();
    return task(combined);
  });
  let abort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        abort = () =>
          reject(
            combined.reason instanceof Error ? combined.reason : new Error('Evaluation cancelled'),
          );
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      }),
      work,
    ]);
  } catch (error) {
    if (combined.aborted) {
      // Allow cooperative cleanup (including a subprocess SIGKILL/close) to finish.
      // A callback that ignores cancellation must not block the evaluation forever.
      let grace;
      await Promise.race([
        work.catch(() => {}),
        new Promise((resolve) => {
          grace = setTimeout(resolve, 500);
        }),
      ]);
      clearTimeout(grace);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) combined.removeEventListener('abort', abort);
  }
}

/** Attach completed spans from another runtime; IDs are local to this batch. */
export function attachedSpans(records, root, parentId) {
  if (!Array.isArray(records) || records.length + root.spans.length > 10_000)
    throw new Error('Agent spans must be an array with at most 10000 total spans');
  const ids = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      !record.id ||
      ids.has(record.id)
    )
      throw new Error('Agent spans require unique nonempty IDs');
    ids.set(record.id, randomUUID());
  }
  const parents = new Map(records.map((record) => [record.id, record.parentId ?? null]));
  const checked = new Set();
  for (const record of records) {
    const path = new Set();
    let id = record.id;
    while (id !== null && !checked.has(id)) {
      if (!parents.has(id)) throw new Error('Agent span parent is absent');
      if (path.has(id)) throw new Error('Agent span tree contains a cycle');
      path.add(id);
      id = parents.get(id);
    }
    for (const item of path) checked.add(item);
  }
  return records.map((record) => {
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 200)
      throw new Error('Agent span name must contain 1–200 characters');
    const kind = record.kind ?? 'function',
      status = record.status ?? 'ok';
    if (
      !['agent', 'llm', 'tool', 'retrieval', 'function'].includes(kind) ||
      !['ok', 'error'].includes(status)
    )
      throw new Error('Invalid agent span kind or status');
    const start = Date.parse(record.startTime),
      end = Date.parse(record.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Agent spans require ordered startTime and endTime');
    const inputTokens = record.inputTokens ?? 0,
      outputTokens = record.outputTokens ?? 0,
      costUsd = record.costUsd ?? null;
    if (
      ![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 1e12))
    )
      throw new Error('Invalid agent span usage');
    if (record.model != null && (typeof record.model !== 'string' || record.model.length > 200))
      throw new Error('Invalid agent span model');
    if (
      record.metadata != null &&
      (typeof record.metadata !== 'object' || Array.isArray(record.metadata))
    )
      throw new Error('Invalid agent span metadata');
    if (record.metadata && Object.keys(record.metadata).some((key) => key.length > 200))
      throw new Error('Agent span metadata keys exceed 200 characters');
    return {
      id: ids.get(record.id),
      traceId: root.id,
      parentId: record.parentId == null ? parentId : ids.get(record.parentId),
      name: record.name,
      kind,
      status,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      input: record.input ?? null,
      output: record.output ?? null,
      metadata: record.metadata ?? {},
      model: record.model ?? null,
      inputTokens,
      outputTokens,
      costUsd,
    };
  });
}

/** Run trusted local agent code. This is process isolation, not a security sandbox. */
export function processTask({
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs = 120_000,
  maxOutputBytes = 1_048_576,
}) {
  if (
    typeof command !== 'string' ||
    !command ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== 'string')
  )
    throw new Error('processTask requires an executable and string arguments');
  duration(timeoutMs, 'timeoutMs');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16_777_216)
    throw new Error('maxOutputBytes must be between 1 and 16777216');
  if (
    !env ||
    typeof env !== 'object' ||
    Object.values(env).some((value) => typeof value !== 'string')
  )
    throw new Error('Agent environment values must be strings');
  return async (input, { metadata = {}, trial = 1, span, signal } = {}) => {
    signal?.throwIfAborted();
    const payload = JSON.stringify({ input, metadata, trial });
    if (Buffer.byteLength(payload) > maxOutputBytes)
      throw new Error('Agent input exceeds byte limit');
    const result = await new Promise((resolve, reject) => {
      const childEnv = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'SYSTEMROOT']
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      );
      const child = spawn(command, args, {
        cwd,
        env: { ...childEnv, ...env },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let failure = null,
        bytes = 0,
        chunks = [],
        killTimer;
      const kill = (sig) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch (error) {
          if (error.code !== 'ESRCH') failure ||= new Error('Unable to stop agent process');
        }
      };
      const stop = (error) => {
        if (failure) return;
        failure = error;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 250);
      };
      const abort = () => stop(new Error('Agent process cancelled'));
      const timer = setTimeout(
        () => stop(new Error(`Agent process timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const consume = (chunk, keep) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) stop(new Error('Agent output exceeds byte limit'));
        else if (keep && !failure) chunks.push(chunk);
      };
      child.stdout.on('data', (chunk) => consume(chunk, true));
      // Provider errors can contain credentials. Never include stderr in persisted errors.
      child.stderr.on('data', (chunk) => consume(chunk, false));
      child.stdin.on('error', () => {});
      child.once('error', (error) => {
        failure ||= new Error(`Agent process could not start (${error.code ?? 'unknown'})`);
      });
      child.once('exit', () => {
        // Descendants holding inherited pipes would otherwise keep "close" pending.
        if (process.platform !== 'win32') kill('SIGKILL');
      });
      child.once('close', (code, childSignal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        // A child may leave descendants behind after exiting; close the group too.
        if (process.platform !== 'win32') kill('SIGKILL');
        if (failure) return reject(failure);
        if (code !== 0)
          return reject(new Error(`Agent process exited with ${childSignal ?? `code ${code}`}`));
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !Object.hasOwn(value, 'output')
          )
            throw new Error();
          resolve(value);
        } catch {
          reject(new Error('Agent process must return one JSON object with output'));
        }
      });
      child.stdin.end(payload + '\n');
    });
    if (result.spans !== undefined) {
      if (!span) throw new Error('Agent spans require an evaluation span context');
      span.addSpans(result.spans);
    }
    if (result.error != null)
      throw new Error(
        typeof result.error === 'string' ? result.error.slice(0, 10000) : 'Agent returned an error',
      );
    return result.output;
  };
}
