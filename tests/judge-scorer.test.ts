import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';

type Api = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<{ status: number; data: any }>;

async function fixture(options: Record<string, unknown> = {}) {
  const instance = createApp({ dbPath: ':memory:', seed: false, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api: Api = async (path, body, method) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const close = async () => {
    await instance.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return { api, close };
}

/** OpenAI-compatible stand-in. `reply` decides the judge's text from the rendered prompt. */
async function provider(reply: (prompt: string) => string, usage = { prompt: 30, completion: 5 }) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const prompt = body.messages.map((m: any) => m.content).join('\n');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: reply(prompt) } }],
        usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion },
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    options: {
      providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      providerApiKey: 'fixture-only-key',
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function project(api: Api) {
  const result = await api('/projects', { name: 'Judge tests' });
  assert.equal(result.status, 201);
  return result.data;
}

async function completed(api: Api, id: string) {
  for (let i = 0; i < 200; i++) {
    const { data } = await api(`/experiments/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(data.experiment.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Evaluation did not complete');
}

const choices = { correct: 1, partial: 0.5, wrong: 0 };

function judge(projectId: string, config: Record<string, unknown> = {}, name = 'Judge') {
  return {
    projectId,
    name,
    type: 'llm_judge',
    config: {
      model: 'judge-model',
      prompt: 'Question: {{input}}\nAnswer: {{output}}\nReference: {{expected}}',
      choices,
      ...config,
    },
  };
}

test('llm_judge configs are validated at creation', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const valid = await f.api('/scorers', judge(p.id));
    assert(valid.status >= 200 && valid.status < 300, JSON.stringify(valid.data));
    assert.equal(
      (await f.api('/scorers', judge(p.id, { prompt: 'Only {{output}}', maxTokens: 1024 }))).status,
      201,
    );
    const invalid: Record<string, Record<string, unknown>> = {
      'no {{output}}': { prompt: 'Question: {{input}}' },
      'one label': { choices: { yes: 1 } },
      'score above 1': { choices: { yes: 1.5, no: 0 } },
      'negative score': { choices: { yes: 1, no: -0.1 } },
      'missing model': { model: undefined },
      'maxTokens above 1024': { maxTokens: 1025 },
      'maxTokensPerRun zero': { maxTokensPerRun: 0 },
      'too many labels': {
        choices: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`l${i}`, i / 20])),
      },
    };
    for (const [label, config] of Object.entries(invalid)) {
      const response = await f.api('/scorers', judge(p.id, config));
      assert.equal(
        response.status,
        400,
        `${label} should be rejected: ${JSON.stringify(response.data)}`,
      );
    }
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`l${i}`, i / 19]));
    assert.equal((await f.api('/scorers', judge(p.id, { choices: twenty }))).status, 201);
  } finally {
    await f.close();
  }
});

test('a judge experiment without a provider key is refused with 503', async () => {
  const f = await fixture();
  try {
    const p = await project(f.api);
    const scorer = (await f.api('/scorers', judge(p.id))).data;
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Rows',
        rows: [{ id: 'a', input: 'q', expected: 'q' }],
      })
    ).data;
    const run = await f.api('/experiments', {
      projectId: p.id,
      name: 'no key',
      datasetId: d.id,
      scorerIds: [scorer.id],
      task: { type: 'echo' },
    });
    assert.equal(run.status, 503, JSON.stringify(run.data));
  } finally {
    await f.close();
  }
});

test('judge replies map to label scores, reasons and separate judge usage', async () => {
  const llm = await provider((prompt) => {
    if (prompt.includes('case-correct')) return '**Correct**.\nMatches the reference exactly';
    if (prompt.includes('case-partial')) return 'PARTIAL';
    if (prompt.includes('case-wrong')) return '"wrong":\nOff topic';
    return 'maybe\nI cannot decide';
  });
  const f = await fixture(llm.options);
  try {
    const p = await project(f.api);
    const scorer = (await f.api('/scorers', judge(p.id, { maxTokens: 64 }))).data;
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'Judge rows',
        rows: [
          { id: 'correct', input: 'case-correct', expected: 'ref-correct' },
          { id: 'partial', input: 'case-partial', expected: 'ref-partial' },
          { id: 'wrong', input: 'case-wrong', expected: 'ref-wrong' },
          { id: 'unknown', input: 'case-unknown', expected: 'ref-unknown' },
        ],
      })
    ).data;
    const run = await f.api('/experiments', {
      projectId: p.id,
      name: 'judged',
      datasetId: d.id,
      scorerIds: [scorer.id],
      task: { type: 'echo' },
      concurrency: 2,
    });
    assert.equal(run.status, 202, JSON.stringify(run.data));
    const detail = await completed(f.api, run.data.id);
    assert.equal(detail.experiment.status, 'completed');
    const byRow = Object.fromEntries(detail.cases.map((c: any) => [c.rowId, c]));

    assert.equal(byRow.correct.scores[scorer.id], 1);
    assert.equal(byRow.correct.scoreExplanations?.[scorer.id], 'Matches the reference exactly');
    assert.equal(byRow.partial.scores[scorer.id], 0.5);
    assert.equal(byRow.wrong.scores[scorer.id], 0);
    assert.equal(byRow.wrong.scoreExplanations?.[scorer.id], 'Off topic');
    assert.equal(byRow.unknown.scores[scorer.id], null);
    assert.equal(typeof byRow.unknown.scoreErrors?.[scorer.id], 'string');
    assert(byRow.unknown.scoreErrors[scorer.id].length > 0);
    for (const row of ['correct', 'partial', 'wrong'])
      assert.equal(byRow[row].scoreErrors?.[scorer.id] ?? null, null, `${row} has no error`);

    for (const c of detail.cases) {
      assert.deepEqual(c.scoreUsage?.[scorer.id], { inputTokens: 30, outputTokens: 5 });
      // The echo task spent no model tokens; judge tokens must not be folded into the case.
      assert.notEqual(c.inputTokens, 30);
      assert.notEqual(c.outputTokens, 5);
    }

    assert.equal(llm.requests.length, 4);
    for (const request of llm.requests) {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.authorization, 'Bearer fixture-only-key');
      assert.equal(request.body.temperature, 0);
      assert.equal(request.body.model, 'judge-model');
    }
    const correctPrompt = llm.requests
      .map((r) => r.body.messages.map((m: any) => m.content).join('\n'))
      .find((text: string) => text.includes('case-correct'))!;
    assert.match(correctPrompt, /Question: "?case-correct"?/);
    assert.match(correctPrompt, /Answer: "?case-correct"?/);
    assert.match(correctPrompt, /Reference: "?ref-correct"?/);
  } finally {
    await f.close();
    await llm.close();
  }
});

test('a missing expected value is an error only for prompts that use {{expected}}', async () => {
  const llm = await provider(() => 'correct\nfine');
  const f = await fixture(llm.options);
  try {
    const p = await project(f.api);
    const usesExpected = (await f.api('/scorers', judge(p.id, {}, 'Uses expected'))).data;
    const ignoresExpected = (
      await f.api(
        '/scorers',
        judge(p.id, { prompt: 'Q: {{input}} A: {{output}}' }, 'Ignores expected'),
      )
    ).data;
    const d = (
      await f.api('/datasets', {
        projectId: p.id,
        name: 'No reference',
        rows: [{ id: 'bare', input: 'question without reference' }],
      })
    ).data;
    const run = await f.api('/experiments', {
      projectId: p.id,
      name: 'expected handling',
      datasetId: d.id,
      scorerIds: [usesExpected.id, ignoresExpected.id],
      task: { type: 'echo' },
    });
    assert.equal(run.status, 202, JSON.stringify(run.data));
    const [only] = (await completed(f.api, run.data.id)).cases;
    assert.equal(only.scores[usesExpected.id], null);
    assert.equal(typeof only.scoreErrors?.[usesExpected.id], 'string');
    assert.equal(only.scores[ignoresExpected.id], 1);
    assert.equal(only.scoreErrors?.[ignoresExpected.id] ?? null, null);
    assert.equal(llm.requests.length, 1, 'only the scorer that can render its prompt calls out');
  } finally {
    await f.close();
    await llm.close();
  }
});

test('an exhausted per-run judge budget makes no call and never counts as a pass', async () => {
  const llm = await provider(() => 'correct\nlooks right', { prompt: 30, completion: 5 });
  const f = await fixture(llm.options);
  try {
    const p = await project(f.api);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      input: `q${i}`,
      expected: `q${i}`,
    }));
    const d = (await f.api('/datasets', { projectId: p.id, name: 'Budget', rows })).data;

    const run = async (name: string, maxTokensPerRun: number) => {
      const scorer = (await f.api('/scorers', judge(p.id, { maxTokens: 8, maxTokensPerRun }, name)))
        .data;
      const before = llm.requests.length;
      const created = await f.api('/experiments', {
        projectId: p.id,
        name,
        datasetId: d.id,
        scorerIds: [scorer.id],
        task: { type: 'echo' },
        concurrency: 1,
      });
      assert.equal(created.status, 202, JSON.stringify(created.data));
      const detail = await completed(f.api, created.data.id);
      return { scorer, detail, calls: llm.requests.length - before };
    };

    // Any call at all would exceed a budget of one token.
    const tiny = await run('tiny budget', 1);
    assert.equal(tiny.calls, 0, 'no judge call is made once the budget would be exceeded');
    for (const c of tiny.detail.cases) {
      assert.equal(c.scores[tiny.scorer.id], null);
      assert.match(c.scoreErrors?.[tiny.scorer.id] ?? '', /budget/i);
    }

    // Room for some calls but not all five (each reports 35 tokens).
    const partial = await run('partial budget', 100);
    assert(partial.calls >= 1 && partial.calls < 5, `calls made: ${partial.calls}`);
    const scored = partial.detail.cases.filter((c: any) => c.scores[partial.scorer.id] !== null);
    const exhausted = partial.detail.cases.filter((c: any) => c.scores[partial.scorer.id] === null);
    assert.equal(scored.length, partial.calls);
    assert(exhausted.length >= 1);
    for (const c of exhausted) assert.match(c.scoreErrors?.[partial.scorer.id] ?? '', /budget/i);
    const usedTokens = scored.reduce(
      (sum: number, c: any) =>
        sum +
        c.scoreUsage[partial.scorer.id].inputTokens +
        c.scoreUsage[partial.scorer.id].outputTokens,
      0,
    );
    assert(usedTokens <= 100, `judge spent ${usedTokens} tokens against a 100 budget`);
    const verdict = await f.api(
      `/experiments/${partial.detail.experiment.id}/gate?minScore=${encodeURIComponent(`${partial.scorer.name}:0.5`)}`,
    );
    assert.equal(verdict.status, 200);
    assert.equal(verdict.data.decision, 'incomplete', JSON.stringify(verdict.data));
  } finally {
    await f.close();
    await llm.close();
  }
});
