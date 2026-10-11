import assert from 'node:assert/strict';
import test from 'node:test';
import {
  averageScore,
  comparisonChange,
  filterDatasetRows,
  sortExperiments,
} from '../web/evaluation-model';
import type { ComparisonRow, DatasetRow, EvalCase, Experiment } from '../shared/types';

test('dataset filters distinguish explicit null ground truth from missing expected values', () => {
  const rows: DatasetRow[] = [
    {
      id: 'explicit',
      input: 'Refund',
      expected: null,
      hasExpected: true,
      metadata: { market: 'EU' },
      tags: ['policy'],
    },
    {
      id: 'missing',
      input: 'Refund',
      expected: null,
      hasExpected: false,
      metadata: {},
      tags: ['edge'],
    },
    { id: 'legacy', input: 'Ship', expected: 'yes', metadata: {}, tags: [] },
  ];
  assert.deepEqual(
    filterDatasetRows(rows, '', '', 'provided').map((r) => r.id),
    ['explicit', 'legacy'],
  );
  assert.deepEqual(
    filterDatasetRows(rows, '  EU ', 'policy', 'all').map((r) => r.id),
    ['explicit'],
  );
  assert.deepEqual(
    filterDatasetRows(rows, 'refund', '', 'missing').map((r) => r.id),
    ['missing'],
  );
  assert.equal(filterDatasetRows(rows, '', 'missing-tag', 'all').length, 0);
});

test('comparison filters preserve mixed changes, unknown scores and unmatched coverage', () => {
  const row = {
    rowId: 'row-1',
    trial: 1,
    input: 'input',
    baseline: {} as EvalCase,
    candidate: {} as EvalCase,
    deltas: { quality: -0.2, safety: 0.4, missing: null },
  } as ComparisonRow;
  assert.equal(comparisonChange(row), 'mixed');
  assert.equal(comparisonChange(row, 'quality'), 'regressed');
  assert.equal(comparisonChange(row, 'safety'), 'improved');
  assert.equal(comparisonChange(row, 'missing'), 'unscored');
  assert.equal(comparisonChange(row, 'absent'), 'unscored');
  assert.equal(comparisonChange({ ...row, candidate: null }), 'unmatched');
  assert.equal(comparisonChange({ ...row, deltas: { quality: 0.3 - 0.1 - 0.2 } }), 'unchanged');
  assert.equal(averageScore({ quality: null }), null);
  assert.equal(averageScore({ quality: 0, safety: 1 }), 0.5);
});

test('experiment numeric sorting leaves unknown metrics last in either direction without mutating data', () => {
  const fixture: Omit<Experiment, 'id' | 'costUsd' | 'scores'> = {
    projectId: 'project',
    name: 'Run',
    description: '',
    datasetId: 'dataset',
    datasetVersion: 1,
    status: 'completed',
    task: { type: 'echo' },
    scorerIds: ['score'],
    trials: 1,
    concurrency: 1,
    totalCases: 1,
    completedCases: 1,
    latencyMs: null,
    unknownCostCount: 0,
    createdAt: '2026-10-11T12:00:00Z',
    finishedAt: null,
    error: null,
  };
  const rows = [
    { ...fixture, id: 'unknown', costUsd: null, scores: { score: null } },
    { ...fixture, id: 'costly', costUsd: 1, scores: { score: 0.8 } },
    { ...fixture, id: 'free', costUsd: 0, scores: { score: 0 } },
  ];
  assert.deepEqual(
    sortExperiments(rows, 'cost', true).map((r) => r.id),
    ['free', 'costly', 'unknown'],
  );
  assert.deepEqual(
    sortExperiments(rows, 'score', false).map((r) => r.id),
    ['costly', 'free', 'unknown'],
  );
  const perScorer = rows.map((row) => ({
    ...row,
    scores: { ...row.scores, safety: row.id === 'free' ? 1 : row.id === 'costly' ? 0 : null },
  }));
  assert.deepEqual(
    sortExperiments(perScorer, 'score', false, 'safety').map((r) => r.id),
    ['free', 'costly', 'unknown'],
  );
  assert.equal(rows[0].id, 'unknown');
});
