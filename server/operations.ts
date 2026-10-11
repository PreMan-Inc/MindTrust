import type { Express, Request } from 'express';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Store } from './store.ts';
import type { EvaluationQueue } from './evaluation.ts';

interface OperationsAccess {
  authenticate(req: Request): void;
  requireOperator(req: Request): void;
}
export function installOperations(
  app: Express,
  store: Store,
  queue: EvaluationQueue,
  access: OperationsAccess,
  options: {
    production?: boolean;
    requestLogging?: boolean;
    maxInFlight?: number;
    premanEmbedding?: boolean;
  } = {},
) {
  let draining = false;
  let active = 0;
  const started = performance.now();
  const counters = new Map<string, { count: number; seconds: number }>();
  const maxInFlight = options.maxInFlight ?? 128;
  const methods = new Set([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
    'CONNECT',
    'TRACE',
  ]);
  app.use((req, res, next) => {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    if (options.production || options.premanEmbedding)
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors ${options.premanEmbedding ? 'https://app.preman.live' : "'none'"}; base-uri 'none'; object-src 'none'`,
      );
    const probe =
      (req.method === 'GET' || req.method === 'HEAD') &&
      ['/livez', '/readyz', '/api/health'].includes(req.path);
    if (!probe && (draining || active >= maxInFlight)) {
      res.setHeader('Retry-After', '5');
      return res
        .status(503)
        .json({ error: 'Service is temporarily busy or draining', requestId: id });
    }
    active++;
    const begin = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      active--;
      // Only route templates are labeled/logged; never URLs, headers, request
      // payloads, login names, trace contents, or provider credentials.
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const elapsed = (performance.now() - begin) / 1000;
      // Arbitrary extension HTTP methods must not create unbounded label keys.
      const method = methods.has(req.method) ? req.method : 'OTHER';
      const key = JSON.stringify([method, route, res.statusCode]);
      const value = counters.get(key) ?? { count: 0, seconds: 0 };
      value.count++;
      value.seconds += elapsed;
      counters.set(key, value);
      if (options.requestLogging)
        process.stdout.write(
          JSON.stringify({
            level: 'info',
            event: 'http_request',
            requestId: id,
            method,
            route,
            status: res.statusCode,
            durationMs: Math.round(elapsed * 1000),
          }) + '\n',
        );
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  });
  // Handle probes before body parsing: even a GET carrying a body must not
  // bypass request admission and allocate JSON buffers through /api/health.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/livez', (_req, res) => res.json({ status: 'alive' }));
  app.get('/readyz', (_req, res) => {
    const ready = !draining && !queue.stats().stopping && store.health();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  const snapshot = () => ({
    uptimeSeconds: Math.floor((performance.now() - started) / 1000),
    draining,
    databaseReady: store.health(),
    activeRequests: active,
    maxInFlight,
    queue: queue.stats(),
    memory: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
    deployment: 'workspace-scoped-single-writer',
  });
  app.get('/api/operations', (req, res) => {
    access.authenticate(req);
    access.requireOperator(req);
    res.json(snapshot());
  });
  app.get('/metrics', (req, res) => {
    access.authenticate(req);
    access.requireOperator(req);
    const quote = (s: unknown) => JSON.stringify(String(s));
    const lines = [
      '# HELP mindtrust_http_requests_total Completed HTTP requests.',
      '# TYPE mindtrust_http_requests_total counter',
    ];
    for (const [key, v] of counters) {
      const [method, route, status] = JSON.parse(key);
      lines.push(
        `mindtrust_http_requests_total{method=${quote(method)},route=${quote(route)},status=${quote(status)}} ${v.count}`,
      );
    }
    lines.push('# TYPE mindtrust_http_request_duration_seconds_sum counter');
    for (const [key, v] of counters) {
      const [method, route, status] = JSON.parse(key);
      lines.push(
        `mindtrust_http_request_duration_seconds_sum{method=${quote(method)},route=${quote(route)},status=${quote(status)}} ${v.seconds}`,
      );
    }
    for (const [name, value] of Object.entries({
      active_requests: active,
      ready: !draining && !queue.stats().stopping && store.health() ? 1 : 0,
      queued_evaluations: queue.stats().queuedJobs,
      active_evaluations: queue.stats().activeJobs,
      active_tasks: queue.stats().activeTasks,
      rss_bytes: process.memoryUsage().rss,
    })) {
      lines.push(`# TYPE mindtrust_${name} gauge`, `mindtrust_${name} ${value}`);
    }
    res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });
  return {
    drain: () => {
      draining = true;
    },
    snapshot,
  };
}
