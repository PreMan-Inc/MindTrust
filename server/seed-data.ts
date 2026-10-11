import type {
  Annotation,
  Dataset,
  DatasetRow,
  EvalCase,
  Experiment,
  Project,
  Prompt,
  Scorer,
  Span,
  Trace,
} from '../shared/types.ts';
import { Store } from './store.ts';
import { aggregateExperiment } from './evaluation.ts';
export function seedDemo(store: Store) {
  if (store.setting('demoSeeded') === 'true' || store.get<Project>('project', 'demo-project'))
    return;
  const now = new Date().toISOString(),
    projectId = 'demo-project';
  store.transaction(() => {
    store.put(
      'project',
      {
        id: projectId,
        name: 'Atlas support agent',
        description:
          'Synthetic demo — no live customer data. Explore traces, evaluations, prompts, and review.',
        createdAt: now,
      } satisfies Project,
      projectId,
    );
    const exact: Scorer = {
      id: 'demo-exact',
      projectId,
      name: 'Answer accuracy',
      type: 'exact_match',
      config: {},
      description: 'Exact match against curated synthetic expected answers.',
      createdAt: now,
    };
    const contains: Scorer = {
      id: 'demo-contains',
      projectId,
      name: 'Required detail',
      type: 'contains',
      config: {},
      description: 'Checks that the expected action appears in the response.',
      createdAt: now,
    };
    store.put('scorer', exact, projectId);
    store.put('scorer', contains, projectId);
    const examples = [
      ['Can I return an unopened order within 30 days?', 'return_eligible'],
      ['Please refund an order that has not been returned.', 'return_required'],
      ['Has order EX-104 shipped?', 'tracking_ready'],
      ['Apply my 10% loyalty discount.', 'discount_applied'],
      ['Delete my saved payment method.', 'payment_removed'],
      ['I was charged twice for the same order.', 'duplicate_charge_review'],
      ['Cancel an order before fulfillment.', 'cancelled'],
      ['How do I update my email address?', 'identity_check_required'],
    ];
    const rows: DatasetRow[] = examples.map(([question, answer], index) => ({
      id: `demo-row-${index + 1}`,
      input: { question, answer },
      expected: answer,
      metadata: { synthetic: true, category: index % 2 ? 'policy' : 'workflow' },
      tags: [index % 2 ? 'policy' : 'workflow'],
    }));
    const dataset: Dataset = {
      id: 'demo-dataset',
      projectId,
      name: 'Support workflows',
      description:
        'Eight synthetic workflow cases. Expected values are action labels, not generated grades.',
      version: 1,
      rowCount: rows.length,
      updatedAt: now,
    };
    store.saveDatasetSnapshot(dataset, rows);
    const prompt: Prompt = {
      id: 'demo-prompt',
      projectId,
      name: 'Support action router',
      description:
        'Synthetic example. Deterministic template uses the fixture answer; switch to a configured provider for real model calls.',
      version: 1,
      system:
        'Classify the required support action. Follow return and identity verification policy.',
      template: '{{input.answer}}',
      model: 'gpt-4.1-mini',
      updatedAt: now,
    };
    store.savePromptVersion(prompt);
    store.savePromptVersion({
      ...prompt,
      version: 2,
      system:
        'Classify the required support action. Confirm the relevant policy and customer identity before taking action.',
      updatedAt: now,
    });
    for (let i = 0; i < 36; i++) {
      const row = rows[i % rows.length],
        start = Date.now() - (35 - i) * 5.7 * 60 * 60 * 1000,
        latency = 420 + ((i * 137) % 2100),
        error = i % 9 === 0,
        traceId = `demo-trace-${i + 1}`,
        rootId = `demo-root-${i + 1}`,
        model = i % 3 === 0 ? 'gpt-4.1-mini' : 'claude-sonnet-4',
        inputTokens = 280 + ((i * 29) % 640),
        outputTokens = 45 + ((i * 11) % 200),
        cost = i % 11 === 0 ? null : (inputTokens * 0.4 + outputTokens * 1.6) / 1000000;
      const trace: Trace = {
        id: traceId,
        projectId,
        name: ['Route support request', 'Validate account policy', 'Resolve order status'][i % 3],
        status: error ? 'error' : 'ok',
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + latency).toISOString(),
        input: row.input,
        output: error ? { error: 'Policy check timed out' } : { action: row.expected },
        tags: ['synthetic', i % 2 ? 'policy' : 'workflow'],
        metadata: {
          synthetic: true,
          environment: 'demo',
          session: `demo-session-${Math.floor(i / 3) + 1}`,
        },
        model,
        latencyMs: latency,
        inputTokens,
        outputTokens,
        costUsd: cost,
        spanCount: 4,
      };
      store.put('trace', trace, projectId);
      store.setTraceSources(traceId, {
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        startTime: true,
        endTime: true,
      });
      const root: Span = {
        id: rootId,
        traceId,
        parentId: null,
        name: 'Support agent',
        kind: 'agent',
        status: trace.status,
        startTime: trace.startTime,
        endTime: trace.endTime,
        input: trace.input,
        output: trace.output,
        metadata: { synthetic: true },
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      };
      const children: Span[] = [
        {
          ...root,
          id: `demo-retrieve-${i + 1}`,
          parentId: rootId,
          name: 'Load support policy',
          kind: 'retrieval',
          endTime: new Date(start + 110).toISOString(),
          output: { policy: 'Synthetic return and identity policies' },
          status: 'ok',
        },
        {
          ...root,
          id: `demo-llm-${i + 1}`,
          parentId: rootId,
          name: 'Choose next action',
          kind: 'llm',
          startTime: new Date(start + 110).toISOString(),
          endTime: new Date(start + latency - 70).toISOString(),
          inputTokens,
          outputTokens,
          costUsd: cost,
          model,
          status: 'ok',
        },
        {
          ...root,
          id: `demo-tool-${i + 1}`,
          parentId: rootId,
          name: error ? 'validate_policy' : 'lookup_order',
          kind: 'tool',
          startTime: new Date(start + latency - 70).toISOString(),
          metadata: { synthetic: true, toolCalls: 1 },
        },
      ];
      for (const span of [root, ...children]) store.put('span', span, projectId, traceId);
    }
    for (const [index, name] of ['Baseline · prompt v1', 'Candidate · prompt v2'].entries()) {
      const id = index ? 'demo-candidate' : 'demo-baseline';
      const cases: EvalCase[] = rows.map((row, r) => {
        const success = index ? r !== 5 : r < 4;
        return {
          id: `${id}-case-${r + 1}`,
          experimentId: id,
          rowId: row.id,
          trial: 1,
          input: row.input,
          expected: row.expected,
          output: success ? row.expected : 'manual_review',
          scores: { [exact.id]: success ? 1 : 0, [contains.id]: success ? 1 : 0 },
          scoreErrors: {},
          error: null,
          latencyMs: (index ? 550 : 900) + r * 74,
          costUsd: (index ? 0.0012 : 0.002) + r * 0.00003,
          inputTokens: 300 + r * 31,
          outputTokens: 65 + r * 12,
          traceId: `demo-trace-${r + 1}`,
        };
      });
      const created = new Date(Date.now() - (index ? 30 : 90) * 60 * 1000).toISOString();
      const experiment: Experiment = {
        id,
        projectId,
        name,
        description:
          'Synthetic, precomputed demonstration. These scores and costs are fixtures, not live benchmark evidence.',
        datasetId: dataset.id,
        datasetVersion: 1,
        status: 'completed',
        executionSource: 'synthetic',
        task: { type: 'template', template: '{{input.answer}}' },
        scorerIds: [exact.id, contains.id],
        trials: 1,
        concurrency: 4,
        totalCases: rows.length,
        completedCases: rows.length,
        scores: {},
        latencyMs: null,
        costUsd: null,
        unknownCostCount: 0,
        createdAt: created,
        finishedAt: created,
        error: null,
      };
      store.saveExperiment(aggregateExperiment(experiment, cases), {
        rows,
        scorers: [exact, contains],
      });
      for (const c of cases) store.put('case', c, projectId, id);
    }
    const annotation: Annotation = {
      id: 'demo-review',
      projectId,
      targetType: 'trace',
      targetId: 'demo-trace-28',
      label: 'needs_review',
      comment: 'Synthetic review: verify the timeout fallback keeps the policy requirement intact.',
      expected: 'return_required',
      createdAt: now,
    };
    store.put('annotation', annotation, projectId, annotation.targetId);
    store.setSetting('demoSeeded', 'true');
  });
}
