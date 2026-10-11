import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type AppOptions } from '../server/app.ts';
import { LEGACY_WORKSPACE_ID } from '../server/store.ts';
import {
  PREMAN_REDEEM_URL,
  redeemPremanCode,
  type PremanExchange,
  type PremanIdentity,
} from '../server/preman.ts';

const BOOTSTRAP = 'independent-preman-test-bootstrap-token-at-least-32-bytes';
const ISSUER = 'https://api.preman.live';
const VERIFIER = 'synthetic-browser-proof-' + 'v'.repeat(43);
const TENANT_A = '637b088c-9975-43b5-b3fc-7dc7c0b6f88a';
const TENANT_B = '0cc11dce-f8f9-4222-87c3-fc0eac3a78e3';

type Auth = { token?: string | null; cookie?: string; csrf?: string; origin?: string };

function identity(overrides: Partial<PremanIdentity> = {}): PremanIdentity {
  return {
    issuer: ISSUER,
    subject: 'immutable-user-a',
    tenant_kind: 'workbench_workspace',
    tenant_id: TENANT_A,
    tenant_name: 'Team Alpha',
    role: 'owner',
    email: 'alpha@example.test',
    email_verified: true,
    session_expires_at: new Date(Date.now() + 240_000).toISOString(),
    ...overrides,
  };
}

async function fixture(t: TestContext, options: AppOptions = {}) {
  const grants = new Map<string, unknown>();
  const upstreamCalls: PremanExchange[] = [];
  const instance = createApp({
    dbPath: ':memory:',
    seed: false,
    adminToken: BOOTSTRAP,
    preman: {
      issuer: ISSUER,
      redeem: async (body) => {
        upstreamCalls.push(body);
        const grant = grants.get(body.code);
        if (!grant || body.code_verifier !== VERIFIER) throw new Error('Invalid synthetic proof');
        grants.delete(body.code);
        return grant;
      },
    },
    ...options,
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await instance.close();
  });
  async function api(path: string, body?: unknown, auth: Auth = {}, method?: string) {
    const token = auth.token === undefined ? BOOTSTRAP : auth.token;
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.csrf ? { 'x-csrf-token': auth.csrf } : {}),
        ...(auth.origin ? { origin: auth.origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, text, headers: response.headers };
  }
  function code(value: unknown = identity()) {
    const valueCode = randomBytes(32).toString('base64url');
    grants.set(valueCode, value);
    return valueCode;
  }
  async function exchange(valueCode: string, verifier = VERIFIER, extra = {}) {
    return api(
      '/api/auth/preman/exchange',
      { code: valueCode, code_verifier: verifier, ...extra },
      { token: null },
    );
  }
  async function login(value: PremanIdentity = identity()) {
    const response = await exchange(code(value));
    assert.equal(response.status, 200, response.text);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const auth: Auth = { token: null, cookie, csrf: response.data.csrfToken };
    return { ...response.data, auth, cookieHeader: response.headers.get('set-cookie')! };
  }
  async function resources(name: string, auth: Auth = {}) {
    const projectResult = await api('/api/projects', { name }, auth);
    assert.equal(projectResult.status, 201, projectResult.text);
    const project = projectResult.data;
    const datasetResult = await api(
      '/api/datasets',
      {
        projectId: project.id,
        name: `${name} dataset`,
        rows: [{ id: `${name}-row`, input: `${name}-PRIVATE-INPUT`, expected: 'answer' }],
      },
      auth,
    );
    assert.equal(datasetResult.status, 201, datasetResult.text);
    const dataset = datasetResult.data;
    const scorer = (
      await api(
        '/api/scorers',
        { projectId: project.id, name: `${name} scorer`, type: 'exact_match' },
        auth,
      )
    ).data;
    const prompt = (
      await api(
        '/api/prompts',
        { projectId: project.id, name: `${name} prompt`, template: '{{input}}' },
        auth,
      )
    ).data;
    const traceResult = await api(
      '/api/traces',
      {
        projectId: project.id,
        traces: [
          {
            id: `${name}-trace`,
            name: `${name} private trace`,
            input: `${name}-PRIVATE-INPUT`,
            output: 'answer',
          },
        ],
      },
      auth,
    );
    assert.equal(traceResult.status, 201, traceResult.text);
    const trace = traceResult.data.ids[0];
    const experimentResult = await api(
      '/api/experiments/import',
      {
        projectId: project.id,
        name: `${name} experiment`,
        datasetId: dataset.id,
        datasetVersion: 1,
        cases: [
          {
            rowId: `${name}-row`,
            input: `${name}-PRIVATE-INPUT`,
            expected: 'answer',
            output: 'answer',
            scores: { quality: 1 },
            traceId: trace,
          },
        ],
      },
      auth,
    );
    assert.equal(experimentResult.status, 201, experimentResult.text);
    const experiment = experimentResult.data;
    const caseRecord = (await api(`/api/experiments/${experiment.id}`, undefined, auth)).data
      .cases[0];
    return { project, dataset, scorer, prompt, trace, experiment, caseRecord, name };
  }
  return { ...instance, base, api, code, login, exchange, resources, upstreamCalls };
}

function denied(result: { status: number; text: string }, path: string) {
  assert(
    [403, 404].includes(result.status),
    `${path}: expected tenant denial, got ${result.status}: ${result.text}`,
  );
  assert(!result.text.includes('PRIVATE-INPUT'), path);
}

test('PreMan workspace admins can read and write only their own native resources', async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const b = await f.login(
    identity({
      subject: 'immutable-user-b',
      tenant_id: TENANT_B,
      tenant_name: 'Team Beta',
      email: 'beta@example.test',
    }),
  );
  assert.notEqual(a.principal.workspaceId, b.principal.workspaceId);
  assert.notEqual(a.principal.workspaceId, LEGACY_WORKSPACE_ID);
  assert.deepEqual((await f.api('/api/projects', undefined, a.auth)).data, []);
  assert.deepEqual((await f.api('/api/projects', undefined, b.auth)).data, []);
  const alpha = await f.resources('alpha', a.auth);
  const beta = await f.resources('beta', b.auth);
  const readPaths = (resource: typeof alpha) => [
    `/api/overview?projectId=${resource.project.id}`,
    `/api/traces?projectId=${resource.project.id}`,
    `/api/traces/export?projectId=${resource.project.id}`,
    `/api/traces/${resource.trace}`,
    `/api/datasets?projectId=${resource.project.id}`,
    `/api/datasets/${resource.dataset.id}`,
    `/api/datasets/${resource.dataset.id}/export`,
    `/api/scorers?projectId=${resource.project.id}`,
    `/api/annotations?projectId=${resource.project.id}`,
    `/api/experiments?projectId=${resource.project.id}`,
    `/api/experiments/${resource.experiment.id}`,
    `/api/experiments/${resource.experiment.id}/export`,
    `/api/compare?baseline=${resource.experiment.id}&candidate=${resource.experiment.id}`,
    `/api/prompts?projectId=${resource.project.id}`,
    `/api/prompts/${resource.prompt.id}`,
  ];
  for (const [session, own, foreign] of [
    [a, alpha, beta],
    [b, beta, alpha],
  ] as const) {
    assert.deepEqual(
      (await f.api('/api/projects', undefined, session.auth)).data.map((p: any) => p.id),
      [own.project.id],
    );
    assert.deepEqual(
      (
        await f.api(
          `/api/projects?workspaceId=${foreign.project.workspaceId}`,
          undefined,
          session.auth,
        )
      ).data.map((p: any) => p.id),
      [own.project.id],
    );
    for (const path of readPaths(own))
      assert.equal((await f.api(path, undefined, session.auth)).status, 200, path);
    for (const path of readPaths(foreign)) denied(await f.api(path, undefined, session.auth), path);
    const writes: [string, unknown, string?][] = [
      ['/api/traces', { projectId: foreign.project.id, traces: [{ name: 'Illegal' }] }],
      [
        '/api/traces',
        {
          projectId: own.project.id,
          traces: [{ id: foreign.trace, name: 'Overwrite other tenant' }],
        },
      ],
      ['/api/datasets', { projectId: foreign.project.id, name: 'Illegal' }],
      [
        `/api/datasets/${foreign.dataset.id}/rows`,
        { rows: [{ id: 'illegal', input: 'overwrite' }] },
      ],
      [`/api/datasets/${foreign.dataset.id}/rows/${foreign.name}-row`, undefined, 'DELETE'],
      [`/api/datasets/${foreign.dataset.id}/import`, { rows: [] }],
      ['/api/scorers', { projectId: foreign.project.id, name: 'Illegal', type: 'exact_match' }],
      [
        '/api/annotations',
        {
          projectId: own.project.id,
          targetType: 'trace',
          targetId: foreign.trace,
          label: 'correct',
        },
      ],
      [
        '/api/annotations',
        {
          projectId: own.project.id,
          targetType: 'case',
          targetId: foreign.caseRecord.id,
          label: 'correct',
        },
      ],
      [
        '/api/experiments',
        { projectId: own.project.id, datasetId: foreign.dataset.id, scorerIds: [own.scorer.id] },
      ],
      [
        '/api/experiments',
        { projectId: own.project.id, datasetId: own.dataset.id, scorerIds: [foreign.scorer.id] },
      ],
      [
        '/api/experiments/import',
        {
          projectId: own.project.id,
          datasetId: own.dataset.id,
          cases: [{ traceId: foreign.trace }],
        },
      ],
      [`/api/experiments/${foreign.experiment.id}/cancel`, {}],
      ['/api/prompts', { projectId: foreign.project.id, name: 'Illegal', template: '{{input}}' }],
      [`/api/prompts/${foreign.prompt.id}/versions`, { template: 'Illegal' }],
      ['/api/playground', { projectId: foreign.project.id }],
    ];
    for (const [path, body, method] of writes)
      denied(await f.api(path, body, session.auth, method), path);
    denied(
      await f.api(
        `/api/compare?baseline=${own.experiment.id}&candidate=${foreign.experiment.id}`,
        undefined,
        session.auth,
      ),
      '/api/compare',
    );
    const unchanged = await f.api(
      `/api/traces/${foreign.trace}`,
      undefined,
      session === a ? b.auth : a.auth,
    );
    assert.equal(unchanged.status, 200);
    assert(!unchanged.text.includes('Overwrite other tenant'));
  }
});

test('tenant API keys, user directory, audit logs and operator powers remain isolated', async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const b = await f.login(
    identity({ subject: 'user-b', tenant_id: TENANT_B, email: 'beta@example.test' }),
  );
  const alpha = await f.resources('key-alpha', a.auth);
  const beta = await f.resources('key-beta', b.auth);
  const keyA = await f.api(
    '/api/keys',
    { name: 'alpha-admin', role: 'admin', projectIds: null },
    a.auth,
  );
  const keyB = await f.api(
    '/api/keys',
    { name: 'beta-admin', role: 'admin', projectIds: null },
    b.auth,
  );
  assert.equal(keyA.status, 201, keyA.text);
  assert.equal(keyB.status, 201, keyB.text);
  for (const [session, own, foreign, ownKey, foreignKey] of [
    [a, alpha, beta, keyA, keyB],
    [b, beta, alpha, keyB, keyA],
  ] as const) {
    const keyAuth = { token: ownKey.data.key };
    assert.deepEqual(
      (await f.api('/api/projects', undefined, keyAuth)).data.map((p: any) => p.id),
      [own.project.id],
    );
    denied(await f.api(`/api/traces/${foreign.trace}`, undefined, keyAuth), 'key foreign trace');
    assert.deepEqual(
      (await f.api('/api/keys', undefined, session.auth)).data.map((key: any) => key.id),
      [ownKey.data.id],
    );
    denied(
      await f.api(`/api/keys/${foreignKey.data.id}`, undefined, session.auth, 'DELETE'),
      'foreign key revoke',
    );
    assert.equal(
      (await f.api('/api/projects', undefined, { token: foreignKey.data.key })).status,
      200,
    );
    denied(
      await f.api(
        '/api/keys',
        { name: 'foreign scope', role: 'viewer', projectIds: [foreign.project.id] },
        session.auth,
      ),
      'foreign key scope',
    );
    const users = await f.api('/api/users', undefined, session.auth);
    assert.equal(users.status, 200);
    assert.deepEqual(
      users.data.map((user: any) => user.id),
      [session.principal.id],
    );
    assert(!users.text.includes(session === a ? 'beta@example.test' : 'alpha@example.test'));
    const audit = await f.api('/api/audit', undefined, session.auth);
    assert.equal(audit.status, 200);
    assert(!audit.text.includes(foreign.project.id));
    assert(!audit.text.includes(foreignKey.data.id));
    assert(audit.data.some((row: any) => row.projectId === own.project.id));
    for (const path of ['/api/operations', '/metrics']) {
      assert.equal((await f.api(path, undefined, session.auth)).status, 403, path);
      assert.equal((await f.api(path, undefined, keyAuth)).status, 403, path);
    }
  }
  assert.equal((await f.api('/api/operations')).status, 200);
  assert.equal((await f.api('/metrics')).status, 200);
});

test('Braintrust project discovery, registration, logs, datasets and BTQL obey workspace boundaries', async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const b = await f.login(
    identity({ subject: 'braintrust-user-b', tenant_id: TENANT_B, email: 'beta@example.test' }),
  );
  const alpha = await f.resources('bt-alpha', a.auth);
  const beta = await f.resources('bt-beta', b.auth);
  const keyA = (
    await f.api('/api/keys', { name: 'sdk-alpha', role: 'admin', projectIds: null }, a.auth)
  ).data.key;
  const auth = { token: keyA };
  assert.equal((await f.api('/api/apikey/login', {}, auth)).status, 200);
  assert.deepEqual(
    (await f.api('/api/project', undefined, auth)).data.objects.map((p: any) => p.id),
    [alpha.project.id],
  );
  for (const path of [
    `/api/project?id=${beta.project.id}`,
    `/v1/project_logs/${beta.project.id}/fetch`,
    `/v1/dataset/${beta.dataset.id}/fetch`,
    `/v1/experiment/${beta.experiment.id}/fetch`,
    `/v1/experiment/${beta.experiment.id}`,
  ])
    denied(await f.api(path, undefined, auth), path);
  for (const [path, body] of [
    ['/api/project/register', { project_id: beta.project.id }],
    ['/api/dataset/register', { project_id: beta.project.id, dataset_name: 'Illegal dataset' }],
    ['/logs3', { rows: [{ project_id: beta.project.id, id: 'injected', input: 'Illegal' }] }],
    ['/logs3', { rows: [{ dataset_id: beta.dataset.id, id: 'injected', input: 'Illegal' }] }],
    [
      '/btql',
      {
        query: {
          select: [{ op: 'star' }],
          from: {
            op: 'function',
            name: { op: 'ident', name: ['dataset'] },
            args: [{ op: 'literal', value: beta.dataset.id }],
          },
        },
      },
    ],
  ] as const)
    denied(await f.api(path, body, auth), path);
  const mixed = await f.api(
    '/logs3',
    {
      rows: [
        {
          project_id: alpha.project.id,
          id: 'would-be-valid',
          input: 'Rollback entire mixed batch',
        },
        { project_id: beta.project.id, id: 'illegal', input: 'Foreign tenant' },
      ],
    },
    auth,
  );
  denied(mixed, '/logs3 mixed batch');
  assert.equal(f.store.get('trace', 'would-be-valid'), undefined);
  const created = await f.api('/api/project/register', { project_name: 'bt-alpha-new' }, auth);
  assert.equal(created.status, 200, created.text);
  assert(
    (await f.api('/api/projects', undefined, a.auth)).data.some(
      (p: any) => p.id === created.data.project.id,
    ),
  );
  assert(
    !(await f.api('/api/projects', undefined, b.auth)).data.some(
      (p: any) => p.id === created.data.project.id,
    ),
  );
});

test('existing local login and API credentials retain legacy data after PreMan sign-in', async (t) => {
  const f = await fixture(t);
  const old = await f.resources('legacy');
  const key = (await f.api('/api/keys', { name: 'existing-key', role: 'admin', projectIds: null }))
    .data;
  const user = await f.api('/api/users', {
    name: 'Existing local admin',
    email: 'alpha@example.test',
    password: 'existing local secret passphrase',
    role: 'admin',
    projectIds: null,
  });
  assert.equal(user.status, 201);
  const localLogin = await f.api(
    '/api/auth/login',
    { email: 'alpha@example.test', password: 'existing local secret passphrase' },
    { token: null },
  );
  assert.equal(localLogin.status, 200);
  const localAuth = {
    token: null,
    cookie: localLogin.headers.get('set-cookie')!.split(';')[0],
    csrf: localLogin.data.csrfToken,
  };
  assert.equal(localLogin.data.principal.workspaceId, LEGACY_WORKSPACE_ID);
  const shared = await f.login();
  assert.notEqual(
    shared.principal.id,
    user.data.id,
    'matching email must not link a local account to a PreMan subject',
  );
  assert.deepEqual((await f.api('/api/projects', undefined, shared.auth)).data, []);
  for (const auth of [{ token: key.key }, localAuth, {}]) {
    assert.deepEqual(
      (await f.api('/api/projects', undefined, auth)).data.map((p: any) => p.id),
      [old.project.id],
    );
    assert.equal((await f.api(`/api/traces/${old.trace}`, undefined, auth)).status, 200);
  }
  denied(await f.api(`/api/traces/${old.trace}`, undefined, shared.auth), 'legacy trace');
  assert.equal(
    (
      await f.api(
        '/api/auth/login',
        { email: 'alpha@example.test', password: 'existing local secret passphrase' },
        { token: null },
      )
    ).status,
    200,
  );
});

test('PreMan subject and workspace identity survive renamed email and cannot be reassigned by email', async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const own = await f.resources('immutable-subject', first.auth);
  const renamed = await f.login(
    identity({ email: 'renamed@example.test', tenant_name: 'Renamed team' }),
  );
  assert.equal(renamed.principal.id, first.principal.id);
  assert.equal(renamed.principal.workspaceId, first.principal.workspaceId);
  assert.equal((await f.api(`/api/traces/${own.trace}`, undefined, renamed.auth)).status, 200);
  const sameEmailOtherSubject = await f.login(
    identity({
      subject: 'different-immutable-subject',
      email: 'renamed@example.test',
      role: 'member',
    }),
  );
  assert.notEqual(sameEmailOtherSubject.principal.id, first.principal.id);
  assert.equal(sameEmailOtherSubject.principal.role, 'editor');
  const secondWorkspace = await f.login(
    identity({ tenant_id: TENANT_B, tenant_name: 'Second workspace' }),
  );
  assert.equal(secondWorkspace.principal.id, first.principal.id);
  assert.notEqual(secondWorkspace.principal.workspaceId, first.principal.workspaceId);
  assert.deepEqual((await f.api('/api/projects', undefined, secondWorkspace.auth)).data, []);
  assert.equal(
    (await f.api('/api/auth/session', undefined, first.auth)).data.principal.workspaceId,
    first.principal.workspaceId,
  );
  denied(
    await f.api(`/api/traces/${own.trace}`, undefined, secondWorkspace.auth),
    'same subject different workspace',
  );
});

test('upstream roles stay authoritative and workspace admins cannot mutate PreMan-managed users', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  const other = await f.login(
    identity({ subject: 'managed-member', role: 'member', email: 'member@example.test' }),
  );
  for (const [path, body, method] of [
    [
      '/api/users',
      {
        name: 'Invented user',
        email: 'new@example.test',
        password: 'new local password secret',
        role: 'admin',
        projectIds: null,
      },
      'POST',
    ],
    [`/api/users/${other.principal.id}`, { role: 'admin', disabled: true }, 'PATCH'],
    [`/api/users/${other.principal.id}/revoke-sessions`, {}, 'POST'],
    [
      '/api/auth/change-password',
      { currentPassword: 'irrelevant secret', newPassword: 'attempted replacement secret' },
      'POST',
    ],
  ] as const)
    assert.equal((await f.api(path, body, admin.auth, method)).status, 403, path);
  const demoted = await f.login(identity({ role: 'member' }));
  assert.equal(demoted.principal.role, 'editor');
  assert.equal(
    (await f.api('/api/keys', undefined, admin.auth)).status,
    403,
    'existing session must observe membership demotion',
  );
  assert.equal((await f.api('/api/users', undefined, demoted.auth)).status, 403);
  assert.equal((await f.api('/api/projects', { name: 'escalation' }, demoted.auth)).status, 403);
});

test('shared sessions require CSRF, carry exact upstream identity, and expire with the grant', async (t) => {
  const f = await fixture(t);
  const upstream = identity();
  const session = await f.login(upstream);
  assert.equal(session.principal.authMethod, 'preman');
  assert.deepEqual(session.upstreamIdentity, {
    issuer: ISSUER,
    subject: upstream.subject,
    tenantKind: 'workbench_workspace',
    tenantId: TENANT_A,
  });
  assert(Date.parse(session.expiresAt) <= Date.parse(upstream.session_expires_at));
  assert.match(session.cookieHeader, /HttpOnly/i);
  assert.match(session.cookieHeader, /SameSite=Strict/i);
  assert.equal(
    (await f.api('/api/projects', { name: 'no-csrf' }, { ...session.auth, csrf: undefined }))
      .status,
    403,
  );
  assert.equal(
    (await f.api('/api/projects', { name: 'wrong-csrf' }, { ...session.auth, csrf: 'wrong' }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.api(
        '/api/projects',
        { name: 'evil-origin' },
        { ...session.auth, origin: 'https://attacker.test' },
      )
    ).status,
    403,
  );
  const short = await f.login(
    identity({ session_expires_at: new Date(Date.now() + 200).toISOString() }),
  );
  await delay(250);
  assert.equal((await f.api('/api/auth/session', undefined, short.auth)).status, 401);
});

test('redemption pins authority and rejects malformed, unverified, or overlong identities', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { issuer: 'https://attacker.test' },
    { issuer: `${ISSUER}/` },
    { subject: '' },
    { tenant_kind: 'organization' },
    { tenant_id: 'legacy' },
    { role: 'operator' },
    { email_verified: false },
    { email: 'not-an-email' },
    { session_expires_at: new Date(Date.now() - 1000).toISOString() },
    { session_expires_at: new Date(Date.now() + 600_000).toISOString() },
    { access_token: 'upstream-secret-must-not-escape' },
  ];
  for (const override of invalid) {
    const code = f.code({ ...identity(), ...override });
    const result = await f.exchange(code);
    assert.equal(result.status, 401, JSON.stringify(override));
    assert.equal(result.headers.get('set-cookie'), null);
    assert(!result.text.includes(code));
    assert(!result.text.includes('upstream-secret-must-not-escape'));
  }
  assert.deepEqual((await f.api('/api/users')).data, []);
});

test('wrong browser proofs and caller-supplied authority never create a session', async (t) => {
  const f = await fixture(t);
  const code = f.code();
  assert.equal((await f.exchange(code, 'wrong-proof-' + 'x'.repeat(43))).status, 401);
  for (const extra of [
    { issuer: 'https://attacker.test' },
    { tenant_id: TENANT_B },
    { role: 'admin' },
    { subject: 'victim' },
    { client_secret: 'must-not-be-needed' },
  ]) {
    const result = await f.exchange(f.code(), VERIFIER, extra);
    assert.equal(result.status, 400, JSON.stringify(extra));
    assert(!result.text.includes('must-not-be-needed'));
  }
  assert.equal(
    f.upstreamCalls.length,
    1,
    'input validation must run before the trusted redemption request',
  );
  const badOrigin = await f.api(
    '/api/auth/preman/exchange',
    { code: f.code(), code_verifier: VERIFIER },
    { token: null, origin: 'https://attacker.test' },
  );
  assert.equal(badOrigin.status, 403);
  assert.equal(f.upstreamCalls.length, 1);
  assert.equal((await f.api('/api/auth/session', undefined, { token: null })).status, 401);
});

test('one code can create only one Verus session even with a replay-tolerant upstream', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    preman: {
      issuer: ISSUER,
      redeem: async () => {
        calls++;
        await delay(25);
        return identity();
      },
    },
  });
  const code = randomBytes(32).toString('base64url');
  const results = await Promise.all(Array.from({ length: 10 }, () => f.exchange(code)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, ...Array(9).fill(401)]);
  assert.equal(calls, 1);
  assert.equal((await f.exchange(code)).status, 401);
  assert.equal(calls, 1);
  const stored = f.store.db.prepare('SELECT * FROM auth_preman_exchanges').all();
  assert(!JSON.stringify(stored).includes(code));
  assert(!JSON.stringify(stored).includes(VERIFIER));
});

test('shared auth responses and audit never contain raw codes, proof verifiers, or stored session tokens', async (t) => {
  const f = await fixture(t);
  const code = f.code();
  const login = await f.exchange(code);
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert(!login.text.includes(code));
  assert(!login.text.includes(VERIFIER));
  const cookieToken = login.headers.get('set-cookie')!.split(';')[0].split('=')[1];
  const sessions = f.store.db.prepare('SELECT * FROM auth_sessions').all();
  assert(!JSON.stringify(sessions).includes(cookieToken));
  const audits = f.store.db.prepare('SELECT * FROM audit_events').all();
  for (const secret of [code, VERIFIER, cookieToken, BOOTSTRAP])
    assert(!JSON.stringify(audits).includes(secret));
});

test('shared login attempts have a finite caller budget', async (t) => {
  const f = await fixture(t, {
    preman: {
      issuer: ISSUER,
      redeem: async () => {
        throw new Error('synthetic upstream denial');
      },
    },
  });
  for (let attempt = 0; attempt < 61; attempt++) {
    const result = await f.exchange(randomBytes(32).toString('base64url'));
    assert.equal(result.status, attempt < 60 ? 401 : 429);
  }
});

test('renewal reuses the live cookie and CSRF while extending only the matching upstream identity', async (t) => {
  const f = await fixture(t);
  const initial = await f.login(
    identity({ session_expires_at: new Date(Date.now() + 60_000).toISOString() }),
  );
  const storedBefore = f.store.db.prepare('SELECT id,token_hash FROM auth_sessions').get();
  const renewedIdentity = identity({
    session_expires_at: new Date(Date.now() + 240_000).toISOString(),
  });
  const realNow = Date.now.bind(Date);
  let clockReads = 0;
  t.mock.method(Date, 'now', () => realNow() + clockReads++);
  const renewed = await f.api(
    '/api/auth/preman/exchange',
    { code: f.code(renewedIdentity), code_verifier: VERIFIER },
    initial.auth,
  );
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.headers.get('set-cookie')!.split(';')[0], initial.auth.cookie);
  assert.equal(renewed.data.csrfToken, initial.csrfToken);
  assert.equal(renewed.data.principal.id, initial.principal.id);
  assert.equal(renewed.data.principal.workspaceId, initial.principal.workspaceId);
  assert(Date.parse(renewed.data.expiresAt) > Date.parse(initial.expiresAt));
  assert(Date.parse(renewed.data.expiresAt) <= Date.parse(renewedIdentity.session_expires_at));
  assert.deepEqual(f.store.db.prepare('SELECT id,token_hash FROM auth_sessions').all(), [
    storedBefore,
  ]);
  const session = await f.api('/api/auth/session', undefined, initial.auth);
  assert.equal(session.status, 200);
  assert.equal(session.data.csrfToken, initial.csrfToken);
  assert.equal(session.data.expiresAt, renewed.data.expiresAt);
});

test('a fresh verified launch rotates and revokes cookies when renewal proof or identity differs', async (t) => {
  const f = await fixture(t);
  for (const [claims, csrfMode] of [
    [{}, 'missing'],
    [{}, 'wrong'],
    [{ subject: 'other-subject' }, 'matching'],
    [{ tenant_id: TENANT_B }, 'matching'],
  ] as const) {
    const initial = await f.login();
    const auth = {
      ...initial.auth,
      csrf:
        csrfMode === 'missing'
          ? undefined
          : csrfMode === 'wrong'
            ? 'wrong-proof'
            : initial.csrfToken,
    };
    const upstream = identity(claims);
    const result = await f.api(
      '/api/auth/preman/exchange',
      { code: f.code(upstream), code_verifier: VERIFIER },
      auth,
    );
    assert.equal(result.status, 200, result.text);
    const cookie = result.headers.get('set-cookie')!.split(';')[0];
    assert.notEqual(cookie, initial.auth.cookie);
    assert.notEqual(result.data.csrfToken, initial.csrfToken);
    assert.equal((await f.api('/api/auth/session', undefined, initial.auth)).status, 401);
    const fresh = await f.api('/api/auth/session', undefined, { token: null, cookie });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.upstreamIdentity.subject, upstream.subject);
    assert.equal(fresh.data.upstreamIdentity.tenantId, upstream.tenant_id);
  }
  assert.equal(
    f.store.db
      .prepare('SELECT count(*) AS count FROM auth_sessions WHERE revoked_at IS NOT NULL')
      .get()!.count,
    4,
  );
});

test('an invalid new launch cannot change or revoke the existing session', async (t) => {
  const f = await fixture(t);
  const initial = await f.login();
  const attempted = await f.api(
    '/api/auth/preman/exchange',
    {
      code: f.code(identity({ subject: 'other-subject' })),
      code_verifier: 'incorrect-proof-' + 'x'.repeat(43),
    },
    initial.auth,
  );
  assert.equal(attempted.status, 401);
  assert.equal(attempted.headers.get('set-cookie'), null);
  const unchanged = await f.api('/api/auth/session', undefined, initial.auth);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.data.principal.id, initial.principal.id);
  assert.equal(unchanged.data.expiresAt, initial.expiresAt);
});

test('unknown and expired cookies permit a fresh independently verified PreMan session', async (t) => {
  const f = await fixture(t);
  const unknown = await f.api(
    '/api/auth/preman/exchange',
    { code: f.code(), code_verifier: VERIFIER },
    { token: null, cookie: 'mindtrust_session=unknown-stale-cookie' },
  );
  assert.equal(unknown.status, 200, unknown.text);
  const initial = await f.login(
    identity({ session_expires_at: new Date(Date.now() + 150).toISOString() }),
  );
  await delay(200);
  assert.equal((await f.api('/api/auth/session', undefined, initial.auth)).status, 401);
  const fresh = await f.api(
    '/api/auth/preman/exchange',
    { code: f.code(), code_verifier: VERIFIER },
    { token: null, cookie: initial.auth.cookie },
  );
  assert.equal(fresh.status, 200, fresh.text);
  assert.notEqual(fresh.headers.get('set-cookie')!.split(';')[0], initial.auth.cookie);
  assert.notEqual(fresh.data.csrfToken, initial.csrfToken);
});

test('PreMan exchange rejects bearer credentials and cross-site preflight authority is exact', async (t) => {
  const f = await fixture(t);
  const deniedBearer = await f.api('/api/auth/preman/exchange', {
    code: f.code(),
    code_verifier: VERIFIER,
  });
  assert.equal(deniedBearer.status, 400, deniedBearer.text);
  assert.equal(f.upstreamCalls.length, 0);
  const preflight = await fetch(`${f.base}/api/auth/preman/exchange`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.preman.live',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token',
    },
  });
  assert([200, 204].includes(preflight.status));
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.preman.live');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  const evil = await fetch(`${f.base}/api/auth/preman/exchange`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.preman.live.attacker.test',
      'access-control-request-method': 'POST',
    },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('embedding grants only the PreMan parent and logout CORS still requires the session CSRF', async (t) => {
  const f = await fixture(t);
  const health = await f.api('/api/health', undefined, { token: null });
  assert.match(
    health.headers.get('content-security-policy') ?? '',
    /frame-ancestors https:\/\/app\.preman\.live(?:;|$)/,
  );
  assert.equal(health.headers.get('x-frame-options'), null);
  const standalone = await fixture(t, { preman: undefined });
  const standaloneHealth = await standalone.api('/api/health', undefined, { token: null });
  assert.equal(standaloneHealth.headers.get('x-frame-options'), 'DENY');
  const session = await f.login();
  const origin = 'https://app.preman.live';
  const deniedLogout = await f.api(
    '/api/auth/logout',
    {},
    { ...session.auth, csrf: undefined, origin },
  );
  assert.equal(deniedLogout.status, 403);
  assert.equal((await f.api('/api/auth/session', undefined, session.auth)).status, 200);
  const logout = await f.api('/api/auth/logout', {}, { ...session.auth, origin });
  assert.equal(logout.status, 200, logout.text);
  assert.equal(logout.headers.get('access-control-allow-origin'), origin);
  assert.equal(logout.headers.get('access-control-allow-credentials'), 'true');
  assert.equal((await f.api('/api/auth/session', undefined, session.auth)).status, 401);
  const native = await f.api('/api/projects', undefined, { ...session.auth, origin });
  assert.equal(native.headers.get('access-control-allow-origin'), null);
});

test('default transport uses the fixed first-party HTTPS redemption endpoint without shared secrets', async (t) => {
  const expected = identity();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), PREMAN_REDEEM_URL);
    assert.equal(PREMAN_REDEEM_URL, 'https://api.preman.live/auth/verus/redeem');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert(init?.signal);
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      code: 'c'.repeat(43),
      code_verifier: VERIFIER,
    });
    return Response.json(expected);
  });
  assert.deepEqual(
    await redeemPremanCode({ code: 'c'.repeat(43), code_verifier: VERIFIER }),
    expected,
  );
  assert.equal(requests, 1);
});
