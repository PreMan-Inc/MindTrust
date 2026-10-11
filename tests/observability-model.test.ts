import assert from 'node:assert/strict';
import test from 'node:test';
import type { Span, Trace } from '../shared/types';
import { orderedSpans, resolveDatasetSource } from '../web/observability-model';

function span(id: string, startTime: string, parentId: string | null = null): Span {
  return {
    id,
    traceId: 'trace',
    parentId,
    name: id,
    kind: 'tool',
    status: 'ok',
    startTime,
    endTime: startTime,
    input: { source: id },
    output: null,
    metadata: {},
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };
}

test('trace tree compares actual instants across timezone offsets and keeps children beneath parents', () => {
  const spans = [
    span('later', '2026-10-11T10:00:00+00:00'),
    span('early', '2026-10-11T12:00:00+03:00'),
    span('child-later', '2026-10-11T09:20:00Z', 'early'),
    span('child-early', '2026-10-11T10:10:00+01:00', 'early'),
  ];
  const rows = orderedSpans(spans);
  assert.deepEqual(
    rows.map(({ span, depth }) => [span.id, depth]),
    [
      ['early', 0],
      ['child-early', 1],
      ['child-later', 1],
      ['later', 0],
    ],
  );
  assert.equal(rows[0].hasChildren, true);
});

test('trace tree preserves orphaned and cyclic spans once, and handles deeply nested traces without recursion', () => {
  const time = '2026-10-11T00:00:00Z';
  const special = [
    span('orphan', time, 'missing'),
    span('cycle-a', time, 'cycle-b'),
    span('cycle-b', time, 'cycle-a'),
  ];
  assert.deepEqual(
    new Set(orderedSpans(special).map(({ span }) => span.id)),
    new Set(special.map((span) => span.id)),
  );
  const deep = Array.from({ length: 10000 }, (_, index) =>
    span(String(index), time, index ? String(index - 1) : null),
  );
  const rows = orderedSpans(deep);
  assert.equal(rows.length, deep.length);
  assert.equal(rows.at(-1)?.depth, 9999);
});

test('dataset conversion never substitutes a whole trace for a vanished selected span', () => {
  const record: Trace = {
    ...span('trace', '2026-10-11T00:00:00Z'),
    projectId: 'project',
    latencyMs: 0,
    tags: [],
    spanCount: 1,
  };
  const selected = span('selected', record.startTime);
  assert.equal(resolveDatasetSource('span', record, selected), selected);
  assert.equal(resolveDatasetSource('trace', record, undefined), record);
  assert.throws(
    () => resolveDatasetSource('span', record, undefined),
    /selected span is no longer available/,
  );
});
