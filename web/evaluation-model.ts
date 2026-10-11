import type { ComparisonRow, DatasetRow, Experiment } from '../shared/types';

export function matchesEvaluationSearch(value: unknown, query: string) {
  if (!query.trim()) return true;
  return (JSON.stringify(value) ?? '').toLowerCase().includes(query.trim().toLowerCase());
}

export function filterDatasetRows(
  rows: DatasetRow[],
  query: string,
  tag: string,
  expected: 'all' | 'provided' | 'missing',
) {
  return rows.filter(
    (row) =>
      matchesEvaluationSearch(row, query) &&
      (!tag || row.tags.includes(tag)) &&
      (expected === 'all' || (row.hasExpected !== false) === (expected === 'provided')),
  );
}

export function averageScore(scores: Record<string, number | null>) {
  const values = Object.values(scores).filter(
    (score): score is number => typeof score === 'number' && Number.isFinite(score),
  );
  return values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : null;
}

export type ExperimentSort = 'created' | 'name' | 'score' | 'latency' | 'cost';
export function sortExperiments(
  rows: Experiment[],
  field: ExperimentSort,
  ascending: boolean,
  scorer = '',
) {
  const value = (row: Experiment): number | string | null =>
    field === 'name'
      ? row.name
      : field === 'created'
        ? row.createdAt
        : field === 'score'
          ? scorer
            ? (row.scores[scorer] ?? null)
            : averageScore(row.scores)
          : field === 'latency'
            ? row.latencyMs
            : row.costUsd;
  return [...rows].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null) return bv === null ? a.id.localeCompare(b.id) : 1;
    if (bv === null) return -1;
    const order =
      typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    return (ascending ? order : -order) || a.id.localeCompare(b.id);
  });
}

export type ComparisonChange =
  'regressed' | 'improved' | 'mixed' | 'unchanged' | 'unscored' | 'unmatched';
export function comparisonChange(row: ComparisonRow, scorer = ''): ComparisonChange {
  if (!row.baseline || !row.candidate) return 'unmatched';
  const deltas = (scorer ? [row.deltas[scorer]] : Object.values(row.deltas)).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (!deltas.length) return 'unscored';
  const down = deltas.some((value) => value < -1e-10);
  const up = deltas.some((value) => value > 1e-10);
  return down && up ? 'mixed' : down ? 'regressed' : up ? 'improved' : 'unchanged';
}
