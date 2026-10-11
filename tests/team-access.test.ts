import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppOptions } from '../server/app.ts';
import { Store } from '../server/store.ts';
import { passwordWorkStats } from '../server/auth.ts';

const rootToken = 'integration-bootstrap-secret-at-least-32-characters';
async function fixture(options: AppOptions = {}) {
  const instance = createApp({
    dbPath: ':memory:',
    seed: false,
    adminToken: rootToken,
    ...options,
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function api(
    path: string,
    body?: unknown,
    options: {
      method?: string;
      token?: string | null;
      cookie?: string;
      csrf?: string;
      origin?: string;
      forwardedFor?: string;
    } = {},
  ) {
    const token = options.token === undefined ? rootToken : options.token;
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
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
    return { status: response.status, data, cookie: response.headers.get('set-cookie') };
  }
  async function key(role: 'viewer' | 'editor' | 'admin', projectIds: string[] | null) {
    const response = await api('/api/keys', { name: `${role} key`, role, projectIds });
    assert.equal(response.status, 201);
    return response.data;
  }
  async function workspace(name: string) {
    const project = (await api('/api/projects', { name })).data;
    const dataset = (
      await api('/api/datasets', {
        projectId: project.id,
        name: `${name} data`,
        rows: [{ id: `${name}-row`, input: 'one', expected: 'one' }],
      })
    ).data;
    const scorer = (
      await api('/api/scorers', {
        projectId: project.id,
        name: `${name} scorer`,
        type: 'exact_match',
      })
    ).data;
    const prompt = (
      await api('/api/prompts', {
        projectId: project.id,
        name: `${name} prompt`,
        template: '{{input}}',
      })
    ).data;
    const trace = (
      await api('/api/traces', {
        projectId: project.id,
        traces: [
          {
            id: `${name}-trace`,
            name: `${name} private trace`,
            input: 'confidential',
            output: 'one',
          },
        ],
      })
    ).data.ids[0];
    const experiment = (
      await api('/api/experiments/import', {
        projectId: project.id,
        name: `${name} run`,
        datasetId: dataset.id,
        datasetVersion: 1,
        cases: [
          {
            rowId: `${name}-row`,
            input: 'one',
            expected: 'one',
            output: 'one',
            scores: { quality: 1 },
            traceId: trace,
          },
        ],
      })
    ).data;
    const c = (await api(`/api/experiments/${experiment.id}`)).data.cases[0];
    return { project, dataset, scorer, prompt, trace, experiment, c };
  }
  return {
    ...instance,
    api,
    key,
    workspace,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await instance.close();
    },
  };
}

test('viewer credentials read only their allowed projects across every native resource surface', async () => {
  const f = await fixture();
  try {
    const a = await f.workspace('allowed'),
      b = await f.workspace('other'),
      viewer = await f.key('viewer', [a.project.id]),
      auth = { token: viewer.key };
    assert.deepEqual(
      (await f.api('/api/projects', undefined, auth)).data.map((p: any) => p.id),
      [a.project.id],
    );
    const readPaths = (w: typeof a) => [
      `/api/overview?projectId=${w.project.id}`,
      `/api/traces?projectId=${w.project.id}`,
      `/api/traces/export?projectId=${w.project.id}`,
      `/api/traces/${w.trace}`,
      `/api/datasets?projectId=${w.project.id}`,
      `/api/datasets/${w.dataset.id}`,
      `/api/datasets/${w.dataset.id}/export`,
      `/api/scorers?projectId=${w.project.id}`,
      `/api/annotations?projectId=${w.project.id}`,
      `/api/experiments?projectId=${w.project.id}`,
      `/api/experiments/${w.experiment.id}`,
      `/api/experiments/${w.experiment.id}/export`,
      `/api/compare?baseline=${w.experiment.id}&candidate=${w.experiment.id}`,
      `/api/prompts?projectId=${w.project.id}`,
      `/api/prompts/${w.prompt.id}`,
    ];
    for (const path of readPaths(a))
      assert.equal((await f.api(path, undefined, auth)).status, 200, path);
    for (const path of readPaths(b)) {
      const result = await f.api(path, undefined, auth);
      assert.equal(result.status, 403, path);
      assert(!JSON.stringify(result.data).includes('confidential'));
    }
    for (const path of ['/api/keys', '/api/users', '/api/audit', '/api/operations', '/metrics'])
      assert.equal((await f.api(path, undefined, auth)).status, 403, path);
    for (const path of ['/api/projects', '/api/info', ...readPaths(a)])
      assert.equal((await f.api(path, undefined, { token: null })).status, 401, path);
    const writes: [string, unknown, string?][] = [
      ['/api/projects', { name: 'Forbidden' }],
      ['/api/traces', { projectId: a.project.id, traces: [] }],
      [
        '/api/annotations',
        { projectId: a.project.id, targetType: 'case', targetId: a.c.id, label: 'correct' },
      ],
      ['/api/datasets', { projectId: a.project.id, name: 'X' }],
      [`/api/datasets/${a.dataset.id}/rows`, { rows: [] }],
      [`/api/datasets/${a.dataset.id}/rows/allowed-row`, undefined, 'DELETE'],
      [`/api/datasets/${a.dataset.id}/import`, { rows: [] }],
      ['/api/scorers', { projectId: a.project.id, name: 'X', type: 'contains' }],
      ['/api/experiments', { projectId: a.project.id }],
      ['/api/experiments/import', { projectId: a.project.id }],
      [`/api/experiments/${a.experiment.id}/cancel`, {}],
      ['/api/prompts', { projectId: a.project.id }],
      [`/api/prompts/${a.prompt.id}/versions`, {}],
      ['/api/playground', { projectId: a.project.id }],
      ['/api/keys', { name: 'No escalation' }],
      ['/api/users', { email: 'viewer@example.test' }],
    ];
    for (const [path, body, method] of writes)
      assert.equal((await f.api(path, body, { ...auth, method })).status, 403, path);
  } finally {
    await f.close();
  }
});

test('editor scopes prevent cross-project references, comparison leaks, OTLP batch writes and privilege escalation', async () => {
  const f = await fixture();
  try {
    const a = await f.workspace('a'),
      b = await f.workspace('b'),
      editor = await f.key('editor', [a.project.id]),
      auth = { token: editor.key };
    assert.equal(
      (
        await f.api(
          '/api/traces',
          { projectId: a.project.id, traces: [{ name: 'Allowed edit' }] },
          auth,
        )
      ).status,
      201,
    );
    const requests: [string, unknown][] = [
      ['/api/traces', { projectId: b.project.id, traces: [{ name: 'Forbidden' }] }],
      ['/api/traces', { projectId: a.project.id, traces: [{ id: b.trace, name: 'Overwrite' }] }],
      [
        '/api/annotations',
        { projectId: a.project.id, targetType: 'trace', targetId: b.trace, label: 'correct' },
      ],
      [
        '/api/annotations',
        { projectId: a.project.id, targetType: 'case', targetId: b.c.id, label: 'correct' },
      ],
      [
        '/api/experiments',
        { projectId: a.project.id, datasetId: b.dataset.id, scorerIds: [a.scorer.id] },
      ],
      [
        '/api/experiments',
        { projectId: a.project.id, datasetId: a.dataset.id, scorerIds: [b.scorer.id] },
      ],
      [
        '/api/experiments/import',
        { projectId: a.project.id, datasetId: a.dataset.id, cases: [{ traceId: b.trace }] },
      ],
      [`/api/datasets/${b.dataset.id}/rows`, { rows: [] }],
      [`/api/prompts/${b.prompt.id}/versions`, {}],
      [`/api/experiments/${b.experiment.id}/cancel`, {}],
      ['/api/keys', { name: 'Escalation', role: 'admin', projectIds: null }],
      ['/api/users', { email: 'editor@example.test' }],
      ['/api/projects', { name: 'Unexpected project' }],
    ];
    for (const [path, body] of requests)
      assert.equal((await f.api(path, body, auth)).status, 403, path);
    assert.equal(
      (
        await f.api(
          `/api/compare?baseline=${a.experiment.id}&candidate=${b.experiment.id}`,
          undefined,
          auth,
        )
      ).status,
      403,
    );
    const spans = (projectId: string, traceId: string) => ({
      resource: {
        attributes: [{ key: 'mindtrust.project_id', value: { stringValue: projectId } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId,
              spanId: 'aaaaaaaaaaaaaaaa',
              name: 'Batch',
              startTimeUnixNano: '1791633600000000000',
              endTimeUnixNano: '1791633600010000000',
            },
          ],
        },
      ],
    });
    const result = await f.api(
      '/v1/traces',
      {
        resourceSpans: [
          spans(a.project.id, '33333333333333333333333333333333'),
          spans(b.project.id, '44444444444444444444444444444444'),
        ],
      },
      auth,
    );
    assert.equal(result.status, 403);
    assert.equal(f.store.get('trace', '33333333333333333333333333333333'), undefined);
  } finally {
    await f.close();
  }
});

test('API keys have explicit scopes, bounded expiration, revocation and hashed storage', async () => {
  const f = await fixture();
  try {
    const p = (await f.api('/api/projects', { name: 'Keys' })).data;
    const key = await f.key('viewer', [p.id]);
    assert.deepEqual(key.projectIds, [p.id]);
    assert(Date.parse(key.expiresAt) > Date.now());
    const stored = f.store.db.prepare('SELECT * FROM api_keys WHERE id=?').get(key.id)!;
    assert(!JSON.stringify(stored).includes(key.key));
    assert.equal(String(stored.hash).length, 64);
    assert.equal(
      (await f.api('/api/keys', { name: 'Scoped admin', role: 'admin', projectIds: [p.id] }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.api('/api/keys', {
          name: 'Past',
          role: 'viewer',
          projectIds: null,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api('/api/keys', {
          name: 'Too long',
          role: 'viewer',
          projectIds: null,
          expiresAt: new Date(Date.now() + 400 * 86400000).toISOString(),
        })
      ).status,
      400,
    );
    f.store.db
      .prepare('UPDATE api_keys SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), key.id);
    assert.equal((await f.api('/api/projects', undefined, { token: key.key })).status, 401);
    const live = await f.key('editor', [p.id]);
    assert.equal(
      (await f.api(`/api/keys/${live.id}`, undefined, { method: 'DELETE' })).status,
      200,
    );
    assert.equal((await f.api('/api/projects', undefined, { token: live.key })).status, 401);
    assert((await f.api('/api/keys')).data.find((k: any) => k.id === live.id).revokedAt);
    const admin = await f.key('admin', null);
    assert.equal((await f.api('/api/users', undefined, { token: admin.key })).status, 200);
  } finally {
    await f.close();
  }
});

test('human sessions use salted password hashes, HttpOnly cookies, CSRF and current user permissions', async () => {
  const f = await fixture();
  try {
    const a = await f.workspace('session-a'),
      b = await f.workspace('session-b');
    const password = 'a long test password 123';
    const create = async (email: string) =>
      f.api('/api/users', {
        email,
        name: 'Teammate',
        password,
        role: 'editor',
        projectIds: [a.project.id],
      });
    const created = await create('editor@example.test'),
      other = await create('other@example.test');
    assert.equal(created.status, 201);
    assert.equal(other.status, 201);
    assert(!JSON.stringify(created.data).includes('hash'));
    const hashes = f.store.db.prepare('SELECT password_hash FROM auth_users').all();
    assert.notEqual(hashes[0].password_hash, hashes[1].password_hash);
    assert(!JSON.stringify(hashes).includes(password));
    const bad = await f.api(
        '/api/auth/login',
        { email: 'editor@example.test', password: 'bad password' },
        { token: null },
      ),
      unknown = await f.api(
        '/api/auth/login',
        { email: 'unknown@example.test', password: 'bad password' },
        { token: null },
      );
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.data, unknown.data);
    const login = await f.api(
      '/api/auth/login',
      { email: 'editor@example.test', password },
      { token: null },
    );
    assert.equal(login.status, 200);
    assert.match(login.cookie!, /HttpOnly/i);
    assert.match(login.cookie!, /SameSite=Strict/i);
    const cookie = login.cookie!.split(';')[0],
      csrf = login.data.csrfToken,
      session = { token: null, cookie, csrf };
    assert.equal(login.data.principal.role, 'editor');
    const sessionRows = f.store.db.prepare('SELECT * FROM auth_sessions').all();
    assert(!JSON.stringify(sessionRows).includes(cookie.split('=')[1]));
    assert.equal(
      (await f.api('/api/auth/session', undefined, session)).data.principal.id,
      created.data.id,
    );
    assert.equal(
      (
        await f.api(
          '/api/traces',
          { projectId: a.project.id, traces: [{ name: 'No CSRF' }] },
          { token: null, cookie },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          '/api/traces',
          { projectId: a.project.id, traces: [{ name: 'Good CSRF' }] },
          session,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await f.api(
          '/api/traces',
          { projectId: a.project.id, traces: [{ name: 'Wrong origin' }] },
          { ...session, origin: 'https://evil.example' },
        )
      ).status,
      403,
    );
    assert.equal((await f.api('/api/keys', { name: 'No escalation' }, session)).status, 403);
    await f.api(
      `/api/users/${created.data.id}`,
      { role: 'viewer', projectIds: [b.project.id] },
      { method: 'PATCH' },
    );
    assert.equal(
      (await f.api(`/api/traces?projectId=${a.project.id}`, undefined, session)).status,
      403,
    );
    assert.equal(
      (await f.api(`/api/traces?projectId=${b.project.id}`, undefined, session)).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          '/api/traces',
          { projectId: b.project.id, traces: [{ name: 'Downgraded' }] },
          session,
        )
      ).status,
      403,
    );
    await f.api(`/api/users/${created.data.id}/revoke-sessions`, {});
    assert.equal((await f.api('/api/auth/session', undefined, session)).status, 401);
    const again = await f.api(
        '/api/auth/login',
        { email: 'editor@example.test', password },
        { token: null },
      ),
      nextSession = {
        token: null,
        cookie: again.cookie!.split(';')[0],
        csrf: again.data.csrfToken,
      };
    await f.api(
      `/api/users/${created.data.id}`,
      { password: 'replacement password 456' },
      { method: 'PATCH' },
    );
    assert.equal((await f.api('/api/auth/session', undefined, nextSession)).status, 401);
    const third = await f.api(
        '/api/auth/login',
        { email: 'editor@example.test', password: 'replacement password 456' },
        { token: null },
      ),
      thirdSession = {
        token: null,
        cookie: third.cookie!.split(';')[0],
        csrf: third.data.csrfToken,
      };
    assert.equal((await f.api('/api/auth/logout', {}, thirdSession)).status, 200);
    assert.equal((await f.api('/api/auth/session', undefined, thirdSession)).status, 401);
    await f.api(`/api/users/${created.data.id}`, { disabled: true }, { method: 'PATCH' });
    assert.equal(
      (
        await f.api(
          '/api/auth/login',
          { email: 'editor@example.test', password: 'replacement password 456' },
          { token: null },
        )
      ).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test('login is rate limited and audit records exclude credentials, emails and request payloads', async () => {
  const f = await fixture({ loginMaxAttempts: 2 });
  try {
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await f.api(
            '/api/auth/login',
            { email: 'hidden@example.test', password: 'never log this secret' },
            { token: null },
          )
        ).status,
        401,
      );
    assert.equal(
      (
        await f.api(
          '/api/auth/login',
          { email: 'hidden@example.test', password: 'never log this secret' },
          { token: null },
        )
      ).status,
      429,
    );
    const p = (await f.api('/api/projects', { name: 'Audit' })).data;
    await f.api('/api/traces', {
      projectId: p.id,
      traces: [
        {
          name: 'Sensitive title',
          input: 'PRIVATE_PAYLOAD_SENTINEL',
          output: 'PRIVATE_OUTPUT_SENTINEL',
        },
      ],
    });
    const events = (await f.api('/api/audit')).data;
    const text = JSON.stringify(events);
    for (const secret of [
      'hidden@example.test',
      'never log this secret',
      'PRIVATE_PAYLOAD_SENTINEL',
      'PRIVATE_OUTPUT_SENTINEL',
      rootToken,
      'Sensitive title',
    ])
      assert(!text.includes(secret), secret);
    assert(events.some((e: any) => e.statusCode === 429));
    assert(events.some((e: any) => e.action === 'http.POST./api/traces' && e.projectId === p.id));
  } finally {
    await f.close();
  }
});

test('production fails closed, uses Secure session cookies, explicit key scopes and no demo seed', async () => {
  assert.throws(
    () => createApp({ dbPath: ':memory:', production: true, adminToken: rootToken }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createApp({
        dbPath: ':memory:',
        production: true,
        adminToken: 'short',
        allowedOrigins: ['https://team.example.test'],
      }),
    /32 characters/,
  );
  const f = await fixture({ production: true, allowedOrigins: ['https://team.example.test'] });
  try {
    assert.equal(f.store.list('project').length, 0);
    assert.equal((await f.api('/api/projects', undefined, { token: null })).status, 401);
    assert.equal((await f.api('/api/keys', { name: 'Implicit scope' })).status, 400);
    await f.api('/api/users', {
      email: 'admin@example.test',
      name: 'Admin',
      password: 'secure passphrase 12345',
      role: 'admin',
      projectIds: null,
    });
    const login = await f.api(
      '/api/auth/login',
      { email: 'admin@example.test', password: 'secure passphrase 12345' },
      { token: null, origin: 'https://team.example.test' },
    );
    assert.equal(login.status, 200);
    assert.match(login.cookie!, /; Secure/i);
    assert.equal(
      (
        await f.api(
          '/api/auth/login',
          { email: 'admin@example.test', password: 'secure passphrase 12345' },
          { token: null, origin: 'http://team.example.test' },
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test('legacy API keys migrate to explicit expiring editor credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindtrust-auth-migration-')),
    path = join(directory, 'db.sqlite');
  const old = new Store(path),
    legacy = 'legacy-fixture-secret';
  old.db
    .prepare('INSERT INTO api_keys(id,name,prefix,hash,created_at) VALUES(?,?,?,?,?)')
    .run(
      'legacy',
      'Existing integration',
      'legacy',
      createHash('sha256').update(legacy).digest('hex'),
      new Date().toISOString(),
    );
  old.close();
  const f = await fixture({ dbPath: path });
  try {
    const keys = (await f.api('/api/keys')).data;
    assert.equal(keys[0].role, 'editor');
    assert.equal(keys[0].projectIds, null);
    assert(Date.parse(keys[0].expiresAt) > Date.now());
    assert(Date.parse(keys[0].expiresAt) < Date.now() + 31 * 86400000);
    assert.equal((await f.api('/api/projects', undefined, { token: legacy })).status, 200);
    assert.equal((await f.api('/api/keys', undefined, { token: legacy })).status, 403);
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('users can replace initial passwords, verify current password and revoke every session', async () => {
  const f = await fixture();
  try {
    const email = 'change-password@example.test',
      initial = 'initial team secret 12345',
      replacement = 'new private passphrase 987';
    await f.api('/api/users', {
      email,
      name: 'User',
      password: initial,
      role: 'viewer',
      projectIds: [],
    });
    const first = await f.api('/api/auth/login', { email, password: initial }, { token: null }),
      second = await f.api('/api/auth/login', { email, password: initial }, { token: null });
    const session = {
        token: null,
        cookie: first.cookie!.split(';')[0],
        csrf: first.data.csrfToken,
      },
      other = { token: null, cookie: second.cookie!.split(';')[0], csrf: second.data.csrfToken };
    assert.equal(
      (
        await f.api(
          '/api/auth/change-password',
          { currentPassword: 'wrong', newPassword: replacement },
          session,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.api(
          '/api/auth/change-password',
          { currentPassword: initial, newPassword: replacement },
          { token: null, cookie: session.cookie },
        )
      ).status,
      403,
    );
    const change = await f.api(
      '/api/auth/change-password',
      { currentPassword: initial, newPassword: replacement },
      session,
    );
    assert.equal(change.status, 200);
    assert.equal(change.data.signInRequired, true);
    assert.equal((await f.api('/api/auth/session', undefined, session)).status, 401);
    assert.equal((await f.api('/api/auth/session', undefined, other)).status, 401);
    assert.equal(
      (await f.api('/api/auth/login', { email, password: initial }, { token: null })).status,
      401,
    );
    assert.equal(
      (await f.api('/api/auth/login', { email, password: replacement }, { token: null })).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test('only explicit trusted proxy IPs can influence login rate-limit identities', async () => {
  assert.throws(
    () => createApp({ dbPath: ':memory:', seed: false, trustedProxies: ['0.0.0.0/0'] }),
    /explicit proxy IP/,
  );
  const trusted = await fixture({ trustedProxies: ['127.0.0.1'], loginMaxAttempts: 1 });
  try {
    assert.equal(
      (
        await trusted.api(
          '/api/auth/login',
          { email: 'first@example.test', password: 'bad' },
          { token: null, forwardedFor: '192.0.2.1' },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await trusted.api(
          '/api/auth/login',
          { email: 'second@example.test', password: 'bad' },
          { token: null, forwardedFor: '192.0.2.2' },
        )
      ).status,
      401,
    );
  } finally {
    await trusted.close();
  }
  const untrusted = await fixture({ loginMaxAttempts: 1 });
  try {
    assert.equal(
      (
        await untrusted.api(
          '/api/auth/login',
          { email: 'third@example.test', password: 'bad' },
          { token: null, forwardedFor: '192.0.2.1' },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await untrusted.api(
          '/api/auth/login',
          { email: 'fourth@example.test', password: 'bad' },
          { token: null, forwardedFor: '192.0.2.2' },
        )
      ).status,
      429,
    );
  } finally {
    await untrusted.close();
  }
});

test('password hashing is bounded under concurrent administrator provisioning', async () => {
  const f = await fixture();
  try {
    let finished = false,
      peakActive = 0,
      peakQueued = 0;
    const requests = Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        f.api('/api/users', {
          email: `capacity-${i}@example.test`,
          name: `User ${i}`,
          password: 'a long fixture passphrase',
          role: 'viewer',
          projectIds: [],
        }),
      ),
    ).finally(() => {
      finished = true;
    });
    while (!finished) {
      const stats = passwordWorkStats();
      peakActive = Math.max(peakActive, stats.active);
      peakQueued = Math.max(peakQueued, stats.queued);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const results = await requests;
    assert(results.every((r) => [201, 503].includes(r.status)));
    assert(peakActive > 0 && peakActive <= 4);
    assert(peakQueued > 0 && peakQueued <= 32);
    assert.equal(passwordWorkStats().active, 0);
    assert.equal(passwordWorkStats().queued, 0);
  } finally {
    await f.close();
  }
});

test('alternate route spelling cannot bypass the native ownership policy', async () => {
  const f = await fixture();
  try {
    const a = await f.workspace('routing-a'),
      b = await f.workspace('routing-b'),
      key = await f.key('viewer', [a.project.id]);
    for (const path of [
      `/api/traces/?projectId=${b.project.id}`,
      `/API/TRACES?projectId=${b.project.id}`,
      `/api/datasets/${b.dataset.id}/`,
      `/api/OVERVIEW?projectId=${b.project.id}`,
    ])
      assert.notEqual((await f.api(path, undefined, { token: key.key })).status, 200, path);
    for (const path of ['/api/traces/', '/API/TRACES', '/api/DATASETS'])
      assert.notEqual(
        (
          await f.api(
            path,
            { projectId: b.project.id, traces: [{ name: 'Bypass attempt' }] },
            { token: key.key },
          )
        ).status,
        201,
        path,
      );
  } finally {
    await f.close();
  }
});

test('password resets and session revocations win races with in-flight password verification', async () => {
  const f = await fixture({ loginMaxAttempts: 100 });
  const password = 'initial-secure-password-123';
  try {
    const user = (
      await f.api('/api/users', {
        email: 'race@example.test',
        name: 'Race test',
        password,
        role: 'viewer',
        projectIds: [],
      })
    ).data;
    const replacement = (
      await f.api('/api/users', {
        email: 'replacement@example.test',
        name: 'Replacement',
        password: 'replacement-secure-password',
        role: 'viewer',
        projectIds: [],
      })
    ).data;
    const replacementHash = (
      f.store.db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(replacement.id) as {
        password_hash: string;
      }
    ).password_hash;
    const login = f.api('/api/auth/login', { email: user.email, password }, { token: null });
    // Wait until real scrypt work has started, then simulate the administrator's
    // already-computed reset committing during password verification.
    while (!passwordWorkStats().active) await new Promise((resolve) => setTimeout(resolve, 1));
    f.store.db
      .prepare('UPDATE auth_users SET password_hash=? WHERE id=?')
      .run(replacementHash, user.id);
    assert.equal((await login).status, 401);
    const signedIn = await f.api(
      '/api/auth/login',
      { email: user.email, password: 'replacement-secure-password' },
      { token: null },
    );
    assert.equal(signedIn.status, 200);
    const changing = f.api(
      '/api/auth/change-password',
      { currentPassword: 'replacement-secure-password', newPassword: 'new-secure-password-1234' },
      { token: null, cookie: signedIn.cookie!.split(';')[0], csrf: signedIn.data.csrfToken },
    );
    while (!passwordWorkStats().active) await new Promise((resolve) => setTimeout(resolve, 1));
    f.store.db
      .prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=?')
      .run(new Date().toISOString(), user.id);
    assert.equal((await changing).status, 409);
    assert.equal(
      (
        f.store.db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get(user.id) as {
          password_hash: string;
        }
      ).password_hash,
      replacementHash,
    );
  } finally {
    await f.close();
  }
});
