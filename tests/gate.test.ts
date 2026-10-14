import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';

const sdkModule = '../sdk/index.mjs';
const { MindTrust, gate, GATE_EXIT_CODES } = (await import(
  sdkModule
)) as typeof import('../sdk/index');
const cliPath = fileURLToPath(new URL('../sdk/cli.mjs', import.meta.url));

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
      headers: {
        'content-type': 'application/json',
        ...(options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const close = async () => {
    await instance.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  };
  return { api, close, baseUrl };
}

async function completed(api: Api, id: string) {
  for (let i = 0; i < 200; i++) {
    const { data } = await api(`/experiments/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(data.experiment.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Evaluation did not complete');
}

/** A project with a two-row dataset, an exact-match scorer, and a helper to run templates. */
async function world(api: Api) {
  const p = (await api('/projects', { name: 'Gate tests' })).data;
  const d = (
    await api('/datasets', {
      projectId: p.id,
      name: 'Gate rows',
      rows: [
        { id: 'a', input: { text: 'a' }, expected: 'a' },
        { id: 'b', input: { text: 'b' }, expected: 'b' },
      ],
    })
  ).data;
  const scorer = (await api('/scorers', { projectId: p.id, name: 'Exact', type: 'exact_match' }))
    .data;
  const run = async (name: string, template: string, extra: Record<string, unknown> = {}) => {
    const created = await api('/experiments', {
      projectId: p.id,
      name,
      datasetId: d.id,
      scorerIds: [scorer.id],
      task: { type: 'template', template },
      ...extra,
    });
    assert.equal(created.status, 202, JSON.stringify(created.data));
    await completed(api, created.data.id);
    return created.data.id as string;
  };
  return { p, d, scorer, run };
}

const gateUrl = (id: string, params: [string, string][] = []) =>
  `/experiments/${id}/gate${params.length ? `?${new URLSearchParams(params)}` : ''}`;

function runCli(args: string[], env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, MINDTRUST_API_KEY: undefined, MINDTRUST_URL: undefined, ...env },
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('gate passes good runs, fails floors and regressions, and reports deltas', async () => {
  const f = await fixture();
  try {
    const w = await world(f.api);
    const good = await w.run('good', '{{input.text}}');
    const good2 = await w.run('good again', '{{input.text}}');
    const bad = await w.run('bad', 'nope');

    const plain = await f.api(gateUrl(good));
    assert.equal(plain.status, 200);
    assert.equal(plain.data.decision, 'pass');
    assert.equal(plain.data.experimentId, good);
    assert(Array.isArray(plain.data.reasons));
    assert.equal(plain.data.comparison, null);

    for (const key of [w.scorer.name, w.scorer.id]) {
      const byKey = await f.api(gateUrl(good, [['minScore', `${key}:0.9`]]));
      assert.equal(byKey.data.decision, 'pass', `${key}: ${JSON.stringify(byKey.data)}`);
    }

    const belowFloor = await f.api(gateUrl(bad, [['minScore', `${w.scorer.name}:0.5`]]));
    assert.equal(belowFloor.data.decision, 'fail');
    assert(belowFloor.data.reasons.length > 0);

    const twoFloors = await f.api(
      gateUrl(good, [
        ['minScore', `${w.scorer.name}:0.5`],
        ['minScore', `${w.scorer.id}:0.99`],
      ]),
    );
    assert.equal(twoFloors.data.decision, 'pass');

    const steady = await f.api(gateUrl(good2, [['baseline', good]]));
    assert.equal(steady.data.decision, 'pass', JSON.stringify(steady.data));
    assert.equal(steady.data.comparison.baselineId, good);
    assert.equal(steady.data.comparison.comparable, true);
    assert.equal(steady.data.comparison.regressions, 0);
    assert.equal(steady.data.comparison.improvements, 0);

    const regressed = await f.api(gateUrl(bad, [['baseline', good]]));
    assert.equal(regressed.data.decision, 'fail');
    assert.equal(regressed.data.comparison.regressions, 2);
    assert.equal(regressed.data.comparison.improvements, 0);
    assert(
      Object.values(regressed.data.comparison.deltas).some((d) => typeof d === 'number' && d < 0),
    );

    const tolerated = await f.api(
      gateUrl(bad, [
        ['baseline', good],
        ['maxRegressions', '2'],
      ]),
    );
    assert.equal(tolerated.data.decision, 'pass', JSON.stringify(tolerated.data));

    const oneShort = await f.api(
      gateUrl(bad, [
        ['baseline', good],
        ['maxRegressions', '1'],
      ]),
    );
    assert.equal(oneShort.data.decision, 'fail');

    const improved = await f.api(gateUrl(good, [['baseline', bad]]));
    assert.equal(improved.data.decision, 'pass');
    assert.equal(improved.data.comparison.improvements, 2);
    assert.equal(improved.data.comparison.regressions, 0);
  } finally {
    await f.close();
  }
});

test('compare keeps its fields and adds regression and improvement counts', async () => {
  const f = await fixture();
  try {
    const w = await world(f.api);
    const good = await w.run('good', '{{input.text}}');
    const bad = await w.run('bad', 'nope');
    const down = (await f.api(`/compare?baseline=${good}&candidate=${bad}`)).data;
    assert.equal(down.comparable, true);
    assert(Array.isArray(down.rows));
    assert.equal(down.rows.length, 2);
    assert.equal(down.regressions, 2);
    assert.equal(down.improvements, 0);
    const up = (await f.api(`/compare?baseline=${bad}&candidate=${good}`)).data;
    assert.equal(up.regressions, 0);
    assert.equal(up.improvements, 2);
  } finally {
    await f.close();
  }
});

test('gate reports incomplete and not-comparable runs and rejects malformed floors', async () => {
  const f = await fixture();
  try {
    const w = await world(f.api);
    const v1 = await w.run('on v1', '{{input.text}}');
    await f.api(`/datasets/${w.d.id}/rows`, {
      rows: [{ id: 'c', input: { text: 'c' }, expected: 'c' }],
    });
    const v2 = await w.run('on v2', '{{input.text}}');
    const crossRevision = await f.api(gateUrl(v2, [['baseline', v1]]));
    assert.equal(crossRevision.status, 200);
    assert.equal(crossRevision.data.decision, 'not_comparable', JSON.stringify(crossRevision.data));
    assert.equal(crossRevision.data.comparison?.comparable, false);

    const withErrors = await f.api('/experiments/import', {
      projectId: w.p.id,
      name: 'scorer errors',
      datasetId: w.d.id,
      datasetVersion: 1,
      cases: [
        {
          rowId: 'a',
          trial: 1,
          input: { text: 'a' },
          expected: 'a',
          output: 'a',
          scores: { quality: null },
          scoreErrors: { quality: 'Judge unavailable' },
        },
      ],
    });
    assert(withErrors.status < 300, JSON.stringify(withErrors.data));
    const erroredGate = await f.api(gateUrl(withErrors.data.id));
    assert.equal(erroredGate.data.decision, 'incomplete', JSON.stringify(erroredGate.data));

    const noScores = await f.api(gateUrl(v1, [['minScore', 'never-scored:0.5']]));
    assert.equal(noScores.status, 200);
    assert.equal(noScores.data.decision, 'incomplete', JSON.stringify(noScores.data));

    const accepted: string[] = [];
    for (const malformed of ['Exact', 'Exact:', 'Exact: ', 'Exact:abc', ':0.5']) {
      const response = await f.api(gateUrl(v1, [['minScore', malformed]]));
      if (response.status !== 400)
        accepted.push(
          `${JSON.stringify(malformed)} -> ${response.status} ${JSON.stringify(response.data)}`,
        );
    }
    assert.deepEqual(accepted, [], 'every malformed minScore must be a 400');
  } finally {
    await f.close();
  }
});

test('a run that has not finished is incomplete', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const llm = createServer(async (req, res) => {
    for await (const _ of req);
    await held;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'a' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  }).listen(0, '127.0.0.1');
  await once(llm, 'listening');
  const address = llm.address();
  assert(address && typeof address !== 'string');
  const f = await fixture({
    providerBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    providerApiKey: 'fixture-only-key',
  });
  try {
    const w = await world(f.api);
    const created = await f.api('/experiments', {
      projectId: w.p.id,
      name: 'still running',
      datasetId: w.d.id,
      scorerIds: [w.scorer.id],
      task: { type: 'openai', template: '{{input.text}}', model: 'fixture-model' },
    });
    assert.equal(created.status, 202, JSON.stringify(created.data));
    const status = (await f.api(`/experiments/${created.data.id}`)).data.experiment.status;
    assert(!['completed', 'failed', 'cancelled'].includes(status), status);
    const verdict = await f.api(gateUrl(created.data.id));
    assert.equal(verdict.data.decision, 'incomplete', JSON.stringify(verdict.data));
    release();
    await completed(f.api, created.data.id);
  } finally {
    release();
    await f.close();
    await new Promise<void>((resolve) => {
      llm.close(() => resolve());
      llm.closeAllConnections();
    });
  }
});

test('SDK gate helpers return the server decision and exit-code mapping', async () => {
  const token = 'gate-admin-token';
  const f = await fixture({ adminToken: token });
  try {
    const w = await world(f.api);
    const good = await w.run('good', '{{input.text}}');
    const bad = await w.run('bad', 'nope');
    assert.deepEqual(
      { ...GATE_EXIT_CODES },
      { pass: 0, fail: 1, not_comparable: 2, incomplete: 2 },
    );

    const passed = await gate({
      baseUrl: f.baseUrl,
      apiKey: token,
      experimentId: good,
      minScores: { [w.scorer.name]: 0.9 },
    });
    assert.equal(passed.decision, 'pass');
    assert.equal(passed.experimentId, good);

    const failed = await gate({
      baseUrl: f.baseUrl,
      apiKey: token,
      experimentId: bad,
      baselineId: good,
      maxRegressions: 0,
    });
    assert.equal(failed.decision, 'fail');
    assert.equal(failed.comparison?.regressions, 2);

    const client = new MindTrust({ baseUrl: f.baseUrl, apiKey: token, projectId: w.p.id });
    const viaClient = await client.gate(bad, { baselineId: good, maxRegressions: 2 });
    assert.equal(viaClient.decision, 'pass');

    await assert.rejects(gate({ baseUrl: f.baseUrl, apiKey: token, experimentId: 'no-such-run' }));
  } finally {
    await f.close();
  }
});

test('CLI exits 0/1/2 by decision and 3 when no decision is reached', async () => {
  const token = 'gate-cli-token';
  const f = await fixture({ adminToken: token });
  try {
    const w = await world(f.api);
    const good = await w.run('good', '{{input.text}}');
    const bad = await w.run('bad', 'nope');
    await f.api(`/datasets/${w.d.id}/rows`, {
      rows: [{ id: 'c', input: { text: 'c' }, expected: 'c' }],
    });
    const later = await w.run('later revision', '{{input.text}}');
    const env = { MINDTRUST_API_KEY: token };
    const url = ['--url', f.baseUrl];

    const pass = await runCli(
      ['gate', good, '--min-score', `${w.scorer.name}=0.8`, ...url, '--json'],
      env,
    );
    assert.equal(pass.code, 0, pass.stderr + pass.stdout);
    const parsed = JSON.parse(pass.stdout);
    assert.equal(parsed.decision, 'pass');
    assert.equal(parsed.experimentId, good);

    const fail = await runCli(['gate', bad, '--baseline', good, ...url], env);
    assert.equal(fail.code, 1, fail.stderr + fail.stdout);

    const floorFail = await runCli(
      [
        'gate',
        bad,
        '--min-score',
        `${w.scorer.name}=0.5`,
        '--min-score',
        `${w.scorer.id}=0.1`,
        ...url,
      ],
      env,
    );
    assert.equal(floorFail.code, 1, floorFail.stderr + floorFail.stdout);

    const tolerated = await runCli(
      ['gate', bad, '--baseline', good, '--max-regressions', '2', ...url],
      env,
    );
    assert.equal(tolerated.code, 0, tolerated.stderr + tolerated.stdout);

    const notComparable = await runCli(['gate', later, '--baseline', good, ...url], env);
    assert.equal(notComparable.code, 2, notComparable.stderr + notComparable.stdout);

    const incomplete = await runCli(['gate', good, '--min-score', 'never-scored=0.5', ...url], env);
    assert.equal(incomplete.code, 2, incomplete.stderr + incomplete.stdout);

    const unknown = await runCli(['gate', 'no-such-run', ...url], env);
    assert.equal(unknown.code, 3, unknown.stderr + unknown.stdout);

    const unauthenticated = await runCli(['gate', good, ...url], {});
    assert.equal(unauthenticated.code, 3, unauthenticated.stderr + unauthenticated.stdout);

    for (const malformed of ['Exact', 'Exact=', 'Exact=abc']) {
      const badFlag = await runCli(['gate', good, '--min-score', malformed, ...url], env);
      assert.equal(badFlag.code, 3, `${malformed}: ${badFlag.stderr}${badFlag.stdout}`);
    }
  } finally {
    await f.close();
  }
  // Nothing listens here once the app is closed.
  const unreachable = await runCli(['gate', 'anything', '--url', f.baseUrl], {
    MINDTRUST_API_KEY: token,
  });
  assert.equal(unreachable.code, 3, unreachable.stderr + unreachable.stdout);
});
