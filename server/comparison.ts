import type {
  Comparison,
  ComparisonRow,
  EvalCase,
  Experiment,
  GateResult,
  Scorer,
} from '../shared/types.ts';
import { stableJson } from './evaluation.ts';
import { HttpError, Store } from './store.ts';

const THRESHOLD = 1e-9;

export function compareExperiments(
  store: Store,
  baselineId: string,
  candidateId: string,
): Comparison & { warnings: string[]; regressions: number; improvements: number } {
  const baseline = store.require<Experiment>('experiment', baselineId),
    candidate = store.require<Experiment>('experiment', candidateId);
  if (baseline.projectId !== candidate.projectId)
    throw new HttpError(400, 'Experiments must belong to the same project');
  const b = store.list<EvalCase>('case', undefined, baseline.id),
    c = store.list<EvalCase>('case', undefined, candidate.id),
    bm = new Map(b.map((v) => [JSON.stringify([v.rowId, v.trial]), v])),
    cm = new Map(c.map((v) => [JSON.stringify([v.rowId, v.trial]), v]));
  const scoreIds = [
    ...new Set([...Object.keys(baseline.scores), ...Object.keys(candidate.scores)]),
  ];
  const deltasFor = (
    a: Record<string, number | null> | undefined,
    z: Record<string, number | null> | undefined,
  ) =>
    Object.fromEntries(
      scoreIds.map((id) => [
        id,
        typeof a?.[id] === 'number' && typeof z?.[id] === 'number' ? z[id]! - a[id]! : null,
      ]),
    );
  const rows: ComparisonRow[] = [...new Set([...bm.keys(), ...cm.keys()])].map((key) => {
    const baseline = bm.get(key) ?? null,
      candidate = cm.get(key) ?? null,
      v = baseline ?? candidate!;
    return {
      rowId: v.rowId,
      trial: v.trial,
      input: v.input,
      baseline,
      candidate,
      deltas: deltasFor(baseline?.scores, candidate?.scores),
    };
  });
  const sameRevision =
    baseline.datasetId === candidate.datasetId &&
    baseline.datasetVersion === candidate.datasetVersion;
  const fullyAligned = rows.every((r) => r.baseline && r.candidate);
  const sameContents = rows.every(
    (r) =>
      !r.baseline ||
      !r.candidate ||
      (stableJson(r.baseline.input) === stableJson(r.candidate.input) &&
        stableJson(r.baseline.expected) === stableJson(r.candidate.expected)),
  );
  const finished = [baseline, candidate].every((e) => e.status === 'completed');
  const bs = store.experimentSnapshot(baseline.id).scorers,
    cs = store.experimentSnapshot(candidate.id).scorers;
  const changedScorers = bs.some((s) => {
    const candidateScorer = cs.find((c) => c.id === s.id);
    return (
      candidateScorer &&
      (candidateScorer.type !== s.type ||
        stableJson(candidateScorer.config) !== stableJson(s.config))
    );
  });
  const unverifiedScorers = scoreIds.some(
    (id) => !bs.some((s) => s.id === id) || !cs.some((s) => s.id === id),
  );
  const comparable = sameRevision && fullyAligned && sameContents && finished && !changedScorers;
  const warnings = [
    !sameRevision
      ? 'Experiments use different dataset revisions; matched IDs do not establish equivalent inputs.'
      : null,
    !fullyAligned ? 'Some rows or trials are unmatched.' : null,
    !sameContents ? 'Matched row IDs have different input or expected content.' : null,
    !finished ? 'One or both experiments are not completed.' : null,
    changedScorers ? 'Scorer definitions changed between experiments.' : null,
    unverifiedScorers
      ? 'Some scores do not have matching server-side scorer snapshots; verify their external implementation before interpreting deltas.'
      : null,
  ].filter((w): w is string => w !== null);
  // One regressed score makes a row a regression, whatever else improved.
  let regressions = 0,
    improvements = 0;
  for (const row of rows) {
    const deltas = Object.values(row.deltas).filter((d): d is number => d !== null);
    if (deltas.some((d) => d < -THRESHOLD)) regressions++;
    else if (deltas.some((d) => d > THRESHOLD)) improvements++;
  }
  return {
    baseline,
    candidate,
    rows,
    deltas: comparable
      ? deltasFor(baseline.scores, candidate.scores)
      : Object.fromEntries(scoreIds.map((id) => [id, null])),
    comparable,
    warning: warnings.length ? warnings.join(' ') : null,
    warnings,
    regressions,
    improvements,
  };
}

/** Reasons an experiment's scores cannot be trusted as a complete run. */
function incompleteReasons(store: Store, experiment: Experiment): string[] {
  if (experiment.status !== 'completed') return [`experiment is ${experiment.status}`];
  const cases = store.list<EvalCase>('case', undefined, experiment.id);
  const reasons: string[] = [];
  if (cases.length < experiment.totalCases)
    reasons.push(`${experiment.totalCases - cases.length} case(s) have no result`);
  const scorerErrors = new Map<string, number>();
  for (const c of cases)
    if (!c.error)
      for (const id of Object.keys(c.scoreErrors))
        scorerErrors.set(id, (scorerErrors.get(id) ?? 0) + 1);
  for (const [id, count] of scorerErrors)
    reasons.push(`scorer ${scorerName(store, experiment, id)} errored on ${count} case(s)`);
  return reasons;
}

function scorerName(store: Store, experiment: Experiment, id: string): string {
  return store.experimentSnapshot(experiment.id).scorers.find((s) => s.id === id)?.name ?? id;
}

/** Accepts a score key as stored (scorer ID or SDK score name) or a server scorer's name. */
function scoreKey(scorers: Scorer[], experiment: Experiment, key: string): string | null {
  if (key in experiment.scores) return key;
  const matches = scorers.filter((s) => s.name === key && s.id in experiment.scores);
  return matches.length === 1 ? matches[0].id : null;
}

export interface GateOptions {
  baselineId?: string;
  maxRegressions?: number;
  minScores?: Record<string, number>;
}

/**
 * A CI decision. Only a complete run can pass, and a baseline comparison only
 * counts when the two runs are comparable; missing evidence is never a pass.
 */
export function gateExperiment(
  store: Store,
  experimentId: string,
  options: GateOptions = {},
): GateResult {
  const experiment = store.require<Experiment>('experiment', experimentId);
  const result = (
    decision: GateResult['decision'],
    reasons: string[],
    comparison: GateResult['comparison'] = null,
  ): GateResult => ({
    decision,
    reasons,
    experimentId: experiment.id,
    comparison,
  });
  const incomplete = incompleteReasons(store, experiment);
  if (incomplete.length) return result('incomplete', incomplete);
  const reasons: string[] = [];
  const failedCases = store
    .list<EvalCase>('case', undefined, experiment.id)
    .filter((c) => c.error).length;
  if (failedCases) reasons.push(`${failedCases} case(s) failed to run`);
  const scorers = store.experimentSnapshot(experiment.id).scorers;
  for (const [name, floor] of Object.entries(options.minScores ?? {})) {
    const key = scoreKey(scorers, experiment, name);
    const mean = key === null ? null : experiment.scores[key];
    if (mean === null || mean === undefined)
      return result('incomplete', [`no ${name} scores to check against ${floor}`]);
    if (mean < floor) reasons.push(`${name} mean ${mean.toFixed(4)} is below ${floor}`);
  }
  let comparison: GateResult['comparison'] = null;
  if (options.baselineId) {
    const compared = compareExperiments(store, options.baselineId, experiment.id);
    comparison = {
      baselineId: compared.baseline.id,
      comparable: compared.comparable,
      regressions: compared.regressions,
      improvements: compared.improvements,
      deltas: compared.deltas,
    };
    if (!compared.comparable) return result('not_comparable', compared.warnings, comparison);
    const baselineIncomplete = incompleteReasons(store, compared.baseline);
    if (baselineIncomplete.length)
      return result(
        'not_comparable',
        baselineIncomplete.map((r) => `baseline: ${r}`),
        comparison,
      );
    const allowed = options.maxRegressions ?? 0;
    if (compared.regressions > allowed)
      reasons.push(`${compared.regressions} case(s) regressed (allowed ${allowed})`);
  }
  return result(reasons.length ? 'fail' : 'pass', reasons, comparison);
}
