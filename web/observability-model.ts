import type { Span, Trace } from '../shared/types';

export function orderedSpans(spans: Span[]) {
  const children = new Map<string, Span[]>();
  const ids = new Set(spans.map((span) => span.id));
  for (const span of spans) {
    if (span.parentId && ids.has(span.parentId)) {
      const nested = children.get(span.parentId) || [];
      nested.push(span);
      children.set(span.parentId, nested);
    }
  }
  const sorted = (items: Span[]) =>
    [...items].sort(
      (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id),
    );
  const roots = sorted(spans.filter((span) => !span.parentId || !ids.has(span.parentId)));
  const result: { span: Span; depth: number; hasChildren: boolean }[] = [];
  const visited = new Set<string>();
  function walk(root: Span) {
    const stack = [{ span: root, depth: 0 }];
    while (stack.length) {
      const row = stack.pop()!;
      if (visited.has(row.span.id)) continue;
      visited.add(row.span.id);
      const nested = sorted(children.get(row.span.id) || []);
      result.push({ ...row, hasChildren: nested.length > 0 });
      for (const span of nested.reverse()) stack.push({ span, depth: row.depth + 1 });
    }
  }
  roots.forEach(walk);
  sorted(spans).forEach((span) => {
    if (!visited.has(span.id)) walk(span);
  });
  return result;
}

export function resolveDatasetSource(
  source: 'trace' | 'span',
  trace: Trace,
  span: Span | undefined,
): Trace | Span {
  if (source === 'trace') return trace;
  if (!span)
    throw new Error(
      'The selected span is no longer available. Select an input source and review its expected output again.',
    );
  return span;
}
