import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Json, Meta, Span, Trace } from '../shared/types.ts';
import { HttpError, Store } from './store.ts';
import { traceSchema } from './validation.ts';
export type TraceInput = z.infer<typeof traceSchema>;
function nonDuplicated(spans: Span[], key: 'inputTokens' | 'outputTokens' | 'costUsd'): Span[] {
  const selected = spans.filter((s) =>
      key === 'costUsd' ? s.costUsd !== null || s.kind === 'llm' : s[key] > 0,
    ),
    map = new Map(spans.map((s) => [s.id, s]));
  const ids = new Set(
    selected.filter((s) => s[key] !== null && (s[key] ?? 0) > 0).map((s) => s.id),
  );
  return selected.filter((s) => {
    let parent = s.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (ids.has(parent)) return false;
      seen.add(parent);
      parent = map.get(parent)?.parentId ?? null;
    }
    return true;
  });
}
function assertHierarchy(spans: Span[]) {
  const map = new Map(spans.map((s) => [s.id, s]));
  for (const span of spans) {
    let p: Span | undefined = span;
    const visited = new Set<string>();
    while (p) {
      if (visited.has(p.id)) throw new HttpError(400, 'Span parent hierarchy contains a cycle');
      visited.add(p.id);
      p = p.parentId ? map.get(p.parentId) : undefined;
    }
  }
}
export function writeTrace(store: Store, projectId: string, input: TraceInput): Trace {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const previous = store.get<Trace>('trace', id);
  if (previous && previous.projectId !== projectId)
    throw new HttpError(409, 'Trace ID belongs to another project');
  const sources = store.traceSources(id);
  for (const key of ['costUsd', 'inputTokens', 'outputTokens', 'startTime', 'endTime'] as const)
    if (Object.hasOwn(input, key)) sources[key] = true;
  const existingSpans = store.list<Span>('span', undefined, id);
  const spansById = new Map(existingSpans.map((s) => [s.id, s]));
  for (const item of input.spans ?? []) {
    const spanId = item.id ?? randomUUID();
    const previousSpan = spansById.get(spanId);
    if (item.traceId && item.traceId !== id)
      throw new HttpError(400, 'Span traceId must match its trace');
    const start = new Date(
      item.startTime ?? previousSpan?.startTime ?? input.startTime ?? now,
    ).toISOString();
    const end = new Date(
      item.endTime ?? previousSpan?.endTime ?? input.endTime ?? now,
    ).toISOString();
    if (Date.parse(end) < Date.parse(start))
      throw new HttpError(400, 'Span endTime must not precede startTime');
    spansById.set(spanId, {
      id: spanId,
      traceId: id,
      parentId: item.parentId === undefined ? (previousSpan?.parentId ?? null) : item.parentId,
      name: item.name ?? previousSpan?.name ?? 'Span',
      kind: item.kind ?? previousSpan?.kind ?? 'function',
      status: item.status ?? previousSpan?.status ?? 'ok',
      startTime: start,
      endTime: end,
      input: item.input === undefined ? (previousSpan?.input ?? null) : item.input,
      output: item.output === undefined ? (previousSpan?.output ?? null) : item.output,
      metadata: item.metadata ?? previousSpan?.metadata ?? {},
      model: item.model === undefined ? (previousSpan?.model ?? null) : item.model,
      inputTokens: item.inputTokens ?? previousSpan?.inputTokens ?? 0,
      outputTokens: item.outputTokens ?? previousSpan?.outputTokens ?? 0,
      costUsd: item.costUsd === undefined ? (previousSpan?.costUsd ?? null) : item.costUsd,
    });
  }
  const spans = [...spansById.values()];
  assertHierarchy(spans);
  const spanStart = spans.length
    ? spans.reduce((min, s) => (s.startTime < min ? s.startTime : min), spans[0].startTime)
    : undefined;
  const spanEnd = spans.length
    ? spans.reduce((max, s) => (s.endTime > max ? s.endTime : max), spans[0].endTime)
    : undefined;
  const start = new Date(
      input.startTime ??
        (sources.startTime ? previous?.startTime : spanStart) ??
        previous?.startTime ??
        now,
    ).toISOString(),
    end = new Date(
      input.endTime ?? (sources.endTime ? previous?.endTime : spanEnd) ?? previous?.endTime ?? now,
    ).toISOString();
  if (Date.parse(end) < Date.parse(start))
    throw new HttpError(400, 'Trace endTime must not precede startTime');
  const pricedSpans = nonDuplicated(spans, 'costUsd');
  const derivedCost =
    pricedSpans.length && pricedSpans.every((s) => s.costUsd !== null)
      ? pricedSpans.reduce((n, s) => n + (s.costUsd ?? 0), 0)
      : null;
  const trace: Trace = {
    id,
    projectId,
    name: input.name,
    status:
      input.status ??
      (spans.some((s) => s.status === 'error') ? 'error' : (previous?.status ?? 'ok')),
    startTime: start,
    endTime: end,
    input: input.input === undefined ? (previous?.input ?? null) : input.input,
    output: input.output === undefined ? (previous?.output ?? null) : input.output,
    tags: input.tags ?? previous?.tags ?? [],
    metadata: input.metadata ?? previous?.metadata ?? {},
    model:
      input.model === undefined
        ? (previous?.model ?? spans.find((s) => s.model)?.model ?? null)
        : input.model,
    latencyMs: Date.parse(end) - Date.parse(start),
    inputTokens:
      input.inputTokens ??
      (sources.inputTokens ? previous?.inputTokens : undefined) ??
      nonDuplicated(spans, 'inputTokens').reduce((n, s) => n + s.inputTokens, 0),
    outputTokens:
      input.outputTokens ??
      (sources.outputTokens ? previous?.outputTokens : undefined) ??
      nonDuplicated(spans, 'outputTokens').reduce((n, s) => n + s.outputTokens, 0),
    costUsd: Object.hasOwn(input, 'costUsd')
      ? input.costUsd!
      : sources.costUsd
        ? (previous?.costUsd ?? null)
        : derivedCost,
    spanCount: spans.length,
  };
  store.put('trace', trace, projectId);
  for (const span of spans) store.put('span', span, projectId, id);
  store.setTraceSources(id, sources);
  return trace;
}
function anyValue(value: unknown): Json {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.intValue === 'string' || typeof v.intValue === 'number') {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : String(v.intValue);
  }
  if (typeof v.doubleValue === 'number' && Number.isFinite(v.doubleValue)) return v.doubleValue;
  if (v.arrayValue && typeof v.arrayValue === 'object')
    return ((v.arrayValue as { values?: unknown[] }).values ?? []).map(anyValue);
  if (v.kvlistValue && typeof v.kvlistValue === 'object')
    return attributes((v.kvlistValue as { values?: unknown[] }).values);
  if (typeof v.bytesValue === 'string') return v.bytesValue;
  return null;
}
function attributes(value: unknown): Meta {
  const result: Meta = Object.create(null);
  if (Array.isArray(value))
    for (const a of value) {
      if (a && typeof a === 'object' && typeof a.key === 'string' && a.key !== '__proto__')
        result[a.key] = anyValue(a.value);
    }
  return result;
}
function otlpId(value: unknown, bytes: number): string {
  if (typeof value !== 'string') throw new Error('Missing OTLP identifier');
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    if (/^0+$/.test(value)) throw new Error('OTLP identifier cannot be all zeros');
    return value.toLowerCase();
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid OTLP identifier');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.every((b) => b === 0))
    throw new Error('Invalid OTLP identifier');
  return decoded.toString('hex');
}
function nanoTime(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('Missing OTLP timestamp');
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('OTLP nanosecond timestamps must be encoded as strings');
  const num = BigInt(value);
  if (num < 0n) throw new Error('Invalid timestamp');
  return new Date(Number(num / 1000000n)).toISOString();
}
function numAttr(value: Json | undefined): number | undefined {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
}
function inputOutput(attrs: Meta, key: 'input' | 'output'): Json {
  const value =
    attrs[`braintrust.${key}`] ??
    attrs[`gen_ai.${key}.messages`] ??
    attrs[`mindtrust.${key}`] ??
    null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
export function ingestOtlp(
  store: Store,
  body: unknown,
  projectHeader?: string,
): { partialSuccess?: { rejectedSpans: number; errorMessage: string } } {
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { resourceSpans?: unknown }).resourceSpans)
  )
    throw new HttpError(400, 'Expected OTLP JSON resourceSpans array');
  const resources = (body as { resourceSpans: unknown[] }).resourceSpans;
  let rejectedSpans = 0;
  let seen = 0;
  const errors = new Set<string>();
  const groups = new Map<
    string,
    { projectId: string; id: string; spans: Span[]; resource: Meta }
  >();
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object')
      throw new HttpError(400, 'Invalid resourceSpans');
    const r = resource as { resource?: { attributes?: unknown }; scopeSpans?: unknown[] };
    const resourceAttrs = attributes(r.resource?.attributes);
    const projectId =
      projectHeader ??
      (typeof resourceAttrs['mindtrust.project_id'] === 'string'
        ? resourceAttrs['mindtrust.project_id']
        : undefined);
    if (!Array.isArray(r.scopeSpans)) throw new HttpError(400, 'Expected scopeSpans array');
    for (const scope of r.scopeSpans) {
      if (
        !scope ||
        typeof scope !== 'object' ||
        !Array.isArray((scope as { spans?: unknown }).spans)
      )
        throw new HttpError(400, 'Expected spans array');
      for (const span of (scope as { spans: unknown[] }).spans) {
        if (++seen > 10000)
          throw new HttpError(413, 'At most 10000 spans are accepted per request');
        try {
          if (!projectId)
            throw new Error(
              'Supply x-mindtrust-project-id or mindtrust.project_id resource attribute',
            );
          store.project(projectId);
          if (!span || typeof span !== 'object') throw new Error('Invalid span');
          const s = span as Record<string, unknown>;
          const traceId = otlpId(s.traceId, 16),
            id = otlpId(s.spanId, 8),
            parentId =
              s.parentSpanId && !/^0+$/.test(String(s.parentSpanId))
                ? otlpId(s.parentSpanId, 8)
                : null;
          const attrs = attributes(s.attributes);
          const spanKind =
            typeof attrs['mindtrust.kind'] === 'string'
              ? attrs['mindtrust.kind']
              : attrs['gen_ai.operation.name']
                ? 'llm'
                : s.kind === 3
                  ? 'tool'
                  : 'function';
          const kind = (
            ['agent', 'llm', 'tool', 'retrieval', 'function'].includes(spanKind as string)
              ? spanKind
              : 'function'
          ) as Span['kind'];
          const startTime = nanoTime(s.startTimeUnixNano),
            endTime = nanoTime(s.endTimeUnixNano);
          if (Date.parse(endTime) < Date.parse(startTime))
            throw new Error('Span end precedes start');
          const otlpStatus = s.status as { code?: unknown } | undefined;
          const normalized: Span = {
            id,
            traceId,
            parentId,
            name: typeof s.name === 'string' && s.name ? s.name : 'OTLP span',
            kind,
            status:
              otlpStatus?.code === 2 || otlpStatus?.code === 'STATUS_CODE_ERROR' ? 'error' : 'ok',
            startTime,
            endTime,
            input: inputOutput(attrs, 'input'),
            output: inputOutput(attrs, 'output'),
            metadata: {
              ...resourceAttrs,
              ...attrs,
              'otlp.startTimeUnixNano': String(s.startTimeUnixNano),
              'otlp.endTimeUnixNano': String(s.endTimeUnixNano),
              ...(Array.isArray(s.events)
                ? { 'otlp.events': JSON.parse(JSON.stringify(s.events)) }
                : {}),
            },
            model:
              typeof attrs['gen_ai.response.model'] === 'string'
                ? attrs['gen_ai.response.model']
                : typeof attrs['gen_ai.request.model'] === 'string'
                  ? attrs['gen_ai.request.model']
                  : null,
            inputTokens: Math.floor(
              numAttr(attrs['gen_ai.usage.input_tokens'] ?? attrs['llm.token_count.prompt']) ?? 0,
            ),
            outputTokens: Math.floor(
              numAttr(attrs['gen_ai.usage.output_tokens'] ?? attrs['llm.token_count.completion']) ??
                0,
            ),
            costUsd: numAttr(attrs['mindtrust.cost_usd'] ?? attrs['braintrust.cost_usd']) ?? null,
          };
          const groupKey = `${projectId}:${traceId}`;
          if (!groups.has(groupKey))
            groups.set(groupKey, { projectId, id: traceId, spans: [], resource: resourceAttrs });
          groups.get(groupKey)!.spans.push(normalized);
        } catch (error) {
          rejectedSpans++;
          errors.add(error instanceof Error ? error.message : 'Invalid span');
        }
      }
    }
  }
  for (const group of groups.values()) {
    try {
      store.transaction(() => {
        const previous = store.get<Trace>('trace', group.id),
          root = group.spans.find((s) => s.parentId === null);
        writeTrace(store, group.projectId, {
          id: group.id,
          name: root?.name ?? previous?.name ?? group.spans[0].name,
          input: root?.input ?? previous?.input ?? null,
          output: root?.output ?? previous?.output ?? null,
          metadata: { ...(previous?.metadata ?? {}), ...group.resource, source: 'otlp-http-json' },
          spans: group.spans,
        });
      });
    } catch (error) {
      rejectedSpans += group.spans.length;
      errors.add(error instanceof Error ? error.message : 'Unable to store trace');
    }
  }
  return rejectedSpans
    ? { partialSuccess: { rejectedSpans, errorMessage: [...errors].slice(0, 5).join('; ') } }
    : {};
}
