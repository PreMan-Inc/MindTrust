import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { PREMAN_ISSUER, PREMAN_REDEEM_URL, type PremanIdentity } from '../server/preman.ts';
import { acquireProcessLock } from '../server/process-lock.ts';
import { LEGACY_WORKSPACE_ID } from '../server/store.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOOTSTRAP = 'synthetic-workspace-binding-bootstrap-token-at-least-32-characters';
const TENANT = '637b088c-9975-43b5-b3fc-7dc7c0b6f88a';
const OTHER_TENANT = '0cc11dce-f8f9-4222-87c3-fc0eac3a78e3';
const SUBJECT = 'synthetic-immutable-binding-subject';
const LEGACY_USER = 'preserved-local-user';
const LEGACY_COOKIE = 'f'.repeat(64);
const LEGACY_KEY = 'synthetic-preserved-api-key';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

function withDatabase<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

// Capture schema and every row so refusals also catch writes made before the transaction.
function snapshot(path: string) {
  return withDatabase(path, (db) => {
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    const tables = schema.filter((row) => row.type === 'table');
    return {
      version: db.prepare('PRAGMA user_version').get(),
      schema,
      rows: Object.fromEntries(
        tables.map((table) => [
          String(table.name),
          db
            .prepare(`SELECT * FROM ${quote(String(table.name))}`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        ]),
      ),
    };
  });
}

async function fixture(t: TestContext, role: PremanIdentity['role'] = 'owner') {
  const directory = await mkdtemp(join(tmpdir(), 'verus-preman-binding-'));
  const path = join(directory, 'workspace.sqlite');
  const noNetwork = join(directory, 'no-network.mjs');
  await writeFile(
    noNetwork,
    "globalThis.fetch = async () => { throw new Error('Offline binding attempted a network request'); };\n",
  );
  let expectedCode = '';
  let redemptionCount = 0;
  const instance = createApp({
    dbPath: path,
    seed: false,
    production: false,
    adminToken: BOOTSTRAP,
    preman: {
      redeem: async (body) => {
        assert.equal(body.code, expectedCode);
        assert.equal(body.code_verifier, 'v'.repeat(43));
        redemptionCount++;
        return {
          issuer: PREMAN_ISSUER,
          subject: SUBJECT,
          tenant_kind: 'workbench_workspace',
          tenant_id: TENANT,
          tenant_name: 'Synthetic verified team',
          role,
          email: 'binding-owner@example.test',
          email_verified: true,
          session_expires_at: new Date(Date.now() + 240_000).toISOString(),
        } satisfies PremanIdentity;
      },
    },
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await instance.close();
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const createdAt = new Date(Date.now() - 86_400_000).toISOString();
  const legacyExpiry = new Date(Date.now() + 86_400_000).toISOString();
  instance.store.createProject(
    {
      id: 'preserved-project',
      name: 'Preserved legacy project',
      description: 'Keep all stored project data and identifiers',
      createdAt,
    },
    LEGACY_WORKSPACE_ID,
  );
  const db = instance.store.db;
  db.prepare(
    'INSERT INTO auth_users(id,email,name,password_hash,role,projects_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    LEGACY_USER,
    'local@example.test',
    'Existing local user',
    'preserved-local-password-hash',
    'editor',
    '["preserved-project"]',
    createdAt,
    createdAt,
  );
  db.prepare(
    "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,'editor','[\"preserved-project\"]','local')",
  ).run(LEGACY_USER, LEGACY_WORKSPACE_ID);
  db.prepare(
    'INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
  ).run('preserved-local-session', LEGACY_USER, hash(LEGACY_COOKIE), legacyExpiry, createdAt);
  db.prepare(
    'INSERT INTO api_keys(id,name,prefix,hash,created_at,role,projects_json,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    'preserved-key',
    'Existing ingestion credential',
    'synthetic',
    hash(LEGACY_KEY),
    createdAt,
    'editor',
    '["preserved-project"]',
    legacyExpiry,
    LEGACY_USER,
  );
  db.prepare(
    'INSERT INTO audit_events(id,at,actor_id,actor_kind,action,project_id,outcome,status_code) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    'preserved-audit',
    createdAt,
    LEGACY_USER,
    'user',
    'fixture.legacy',
    'preserved-project',
    'success',
    200,
  );
  expectedCode = randomBytes(32).toString('base64url');
  const response = await fetch(`${base}/api/auth/preman/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: expectedCode, code_verifier: 'v'.repeat(43) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const session = (await response.json()) as {
    csrfToken: string;
    principal: { id: string; workspaceId: string };
  };
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  assert.equal(redemptionCount, 1);
  const target = session.principal.workspaceId;
  const userId = session.principal.id;
  const sessionRow = db.prepare('SELECT id FROM auth_sessions WHERE user_id=?').get(userId)!;
  const sessionId = String(sessionRow.id);
  await stop();
  function mutate(action: (db: DatabaseSync) => void) {
    withDatabase(path, action);
  }
  function sessionField(field: string, value: SQLInputValue) {
    mutate((db) =>
      db.prepare(`UPDATE auth_sessions SET ${quote(field)}=? WHERE id=?`).run(value, sessionId),
    );
  }
  function upstream(overrides: Record<string, unknown>) {
    sessionField(
      'upstream_identity_json',
      JSON.stringify({
        issuer: PREMAN_ISSUER,
        subject: SUBJECT,
        tenantKind: 'workbench_workspace',
        tenantId: TENANT,
        ...overrides,
      }),
    );
  }
  async function run(arguments_: string[], preload = noNetwork) {
    return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          '--import',
          preload,
          'scripts/bind-preman-workspace.ts',
          path,
          ...arguments_,
        ],
        { cwd: ROOT, timeout: 15_000, env: { ...process.env, NODE_ENV: 'test' } },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          resolve({ status: (error?.code as number) ?? 0, stdout, stderr });
        },
      );
    });
  }
  function cli(selected = target, extra: string[] = []) {
    return run(['--existing-workspace', selected, ...extra]);
  }
  return {
    directory,
    path,
    target,
    userId,
    sessionId,
    cookie,
    csrfToken: session.csrfToken,
    mutate,
    sessionField,
    upstream,
    cli,
    run,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertRefused(f: Fixture, selected = f.target, extra: string[] = []) {
  const before = snapshot(f.path);
  const result = await f.cli(selected, extra);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    snapshot(f.path),
    before,
    'Refused binding must leave schema and every row unchanged',
  );
  assert(
    !result.stdout.includes(SUBJECT) && !result.stderr.includes(SUBJECT),
    'Do not print stored identity data',
  );
}

for (const role of ['owner', 'admin'] as const) {
  test(`offline binding accepts a live PreMan ${role} and preserves legacy rows, session cookies, and API keys`, async (t) => {
    const f = await fixture(t, role);
    const before = snapshot(f.path);
    const targetWorkspace = withDatabase(f.path, (db) =>
      db.prepare('SELECT * FROM workspaces WHERE id=?').get(f.target)!,
    );
    const result = await f.cli();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const after = snapshot(f.path);
    assert.deepEqual(after.schema, before.schema);
    assert.deepEqual(after.version, before.version);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (['workspaces', 'auth_workspace_members', 'auth_sessions', 'audit_events'].includes(table))
        continue;
      assert.deepEqual(after.rows[table], rows, `${table} must remain unchanged`);
    }
    for (const table of ['auth_workspace_members', 'auth_sessions', 'audit_events']) {
      const movedRows = before.rows[table]
        .map((row) => {
          const data = JSON.parse(row);
          if (data.workspace_id === f.target) data.workspace_id = LEGACY_WORKSPACE_ID;
          return JSON.stringify(data);
        })
        .sort();
      assert.deepEqual(
        after.rows[table].filter((row) => {
          const data = JSON.parse(row);
          return !(table === 'audit_events' && data.action === 'workspace.bind.preman.existing');
        }),
        movedRows,
        `${table}: only target workspace references may change`,
      );
    }
    withDatabase(f.path, (db) => {
      assert.equal(db.prepare('SELECT id FROM workspaces WHERE id=?').get(f.target), undefined);
      const legacy = db.prepare('SELECT * FROM workspaces WHERE id=?').get(LEGACY_WORKSPACE_ID)!;
      assert.equal(legacy.preman_issuer, targetWorkspace.preman_issuer);
      assert.equal(legacy.preman_tenant_id, targetWorkspace.preman_tenant_id);
      assert.equal(legacy.name, targetWorkspace.name);
      assert.equal(
        legacy.created_at,
        JSON.parse(
          before.rows.workspaces.find((row) => JSON.parse(row).id === LEGACY_WORKSPACE_ID)!,
        ).created_at,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const audit = db
        .prepare("SELECT * FROM audit_events WHERE action='workspace.bind.preman.existing'")
        .all();
      assert.equal(audit.length, 1);
      assert.equal(audit[0].workspace_id, LEGACY_WORKSPACE_ID);
    });

    const restarted = createApp({
      dbPath: f.path,
      seed: false,
      production: false,
      adminToken: BOOTSTRAP,
    });
    const server = restarted.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: f.cookie } });
      assert.equal(session.status, 200);
      const sessionBody = await session.json();
      assert.equal(sessionBody.principal.id, f.userId);
      assert.equal(sessionBody.principal.workspaceId, LEGACY_WORKSPACE_ID);
      assert.equal(sessionBody.csrfToken, f.csrfToken);
      for (const headers of [
        { cookie: f.cookie },
        { cookie: `mindtrust_session=${LEGACY_COOKIE}` },
        { authorization: `Bearer ${LEGACY_KEY}` },
      ] as Record<string, string>[]) {
        const projects = await fetch(`${base}/api/projects`, { headers });
        assert.equal(projects.status, 200);
        assert.deepEqual(
          (await projects.json()).map((project: { id: string }) => project.id),
          ['preserved-project'],
        );
      }
      const write = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          'x-csrf-token': f.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Write using the preserved cookie and CSRF token' }),
      });
      assert.equal(write.status, 201, await write.text());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await restarted.close();
    }
    await assertRefused(f, LEGACY_WORKSPACE_ID);
  });
}

test('offline binding accepts a freshly renewed session whose original creation is old', async (t) => {
  const f = await fixture(t);
  f.sessionField('created_at', new Date(Date.now() - 30 * 86_400_000).toISOString());
  f.sessionField('expires_at', new Date(Date.now() + 240_000).toISOString());
  const result = await f.cli();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('offline binding carries valid PreMan member identities and expired or revoked sessions with the owner', async (t) => {
  const f = await fixture(t);
  const memberId = randomUUID();
  f.mutate((db) => {
    db.prepare(
      'INSERT INTO auth_users SELECT ?,email,name,password_hash,role,projects_json,disabled,allow_oidc,oidc_issuer,oidc_subject,created_at,updated_at,identity_source FROM auth_users WHERE id=?',
    ).run(memberId, f.userId);
    db.prepare('INSERT INTO auth_external_identities(issuer,subject,user_id) VALUES(?,?,?)').run(
      PREMAN_ISSUER,
      'synthetic-secondary-member',
      memberId,
    );
    db.prepare(
      "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,'editor','null','preman')",
    ).run(memberId, f.target);
    const upstream = JSON.stringify({
      issuer: PREMAN_ISSUER,
      subject: 'synthetic-secondary-member',
      tenantKind: 'workbench_workspace',
      tenantId: TENANT,
    });
    for (const state of ['expired', 'revoked']) {
      db.prepare(
        "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,revoked_at,created_at,workspace_id,auth_method,upstream_identity_json) VALUES(?,?,?,?,?,?,?,'preman',?)",
      ).run(
        `${state}-secondary-session`,
        memberId,
        hash(state),
        new Date(Date.now() + (state === 'expired' ? -60_000 : 240_000)).toISOString(),
        state === 'revoked' ? new Date().toISOString() : null,
        new Date(Date.now() - 120_000).toISOString(),
        f.target,
        upstream,
      );
    }
  });
  const before = snapshot(f.path);
  const result = await f.cli();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = snapshot(f.path);
  for (const table of ['auth_sessions', 'auth_workspace_members']) {
    assert.deepEqual(
      after.rows[table],
      before.rows[table]
        .map((row) => {
          const value = JSON.parse(row);
          if (value.workspace_id === f.target) value.workspace_id = LEGACY_WORKSPACE_ID;
          return JSON.stringify(value);
        })
        .sort(),
    );
  }
  assert.deepEqual(after.rows.auth_users, before.rows.auth_users);
  assert.deepEqual(after.rows.auth_external_identities, before.rows.auth_external_identities);
});

const refusedCases: [string, (f: Fixture) => void][] = [
  [
    'a target project',
    (f) =>
      f.mutate((db) => {
        db.prepare('INSERT INTO project_workspaces(project_id,workspace_id) VALUES(?,?)').run(
          'target-project',
          f.target,
        );
        db.prepare("INSERT INTO records(kind,id,project_id,value) VALUES('project',?,?,?)").run(
          'target-project',
          'target-project',
          JSON.stringify({ id: 'target-project', name: 'Must not merge' }),
        );
      }),
  ],
  [
    'a target API key even when revoked',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE api_keys SET workspace_id=?,revoked_at=? WHERE id=?')
          .run(f.target, new Date().toISOString(), 'preserved-key'),
      ),
  ],
  [
    'no target session',
    (f) => f.mutate((db) => db.prepare('DELETE FROM auth_sessions WHERE id=?').run(f.sessionId)),
  ],
  [
    'an expired session',
    (f) => f.sessionField('expires_at', new Date(Date.now() - 1_000).toISOString()),
  ],
  ['a revoked session', (f) => f.sessionField('revoked_at', new Date().toISOString())],
  [
    'a future session creation',
    (f) => f.sessionField('created_at', new Date(Date.now() + 60_000).toISOString()),
  ],
  ['an invalid session creation', (f) => f.sessionField('created_at', 'invalid-date')],
  ['an invalid session expiry', (f) => f.sessionField('expires_at', 'invalid-date')],
  [
    'a session expiry over five minutes away',
    (f) => f.sessionField('expires_at', new Date(Date.now() + 600_000).toISOString()),
  ],
  ['a local target session', (f) => f.sessionField('auth_method', 'local')],
  ['an OIDC target session', (f) => f.sessionField('auth_method', 'oidc')],
  ['a missing immutable identity', (f) => f.sessionField('upstream_identity_json', null)],
  [
    'malformed immutable identity JSON',
    (f) => f.sessionField('upstream_identity_json', '{bad-json'),
  ],
  ['a different immutable subject', (f) => f.upstream({ subject: 'wrong-subject' })],
  ['a different immutable issuer', (f) => f.upstream({ issuer: 'https://untrusted.example.test' })],
  ['a different immutable tenant', (f) => f.upstream({ tenantId: OTHER_TENANT })],
  ['a different immutable tenant kind', (f) => f.upstream({ tenantKind: 'organization' })],
  [
    'a missing external identity mapping',
    (f) =>
      f.mutate((db) =>
        db.prepare('DELETE FROM auth_external_identities WHERE user_id=?').run(f.userId),
      ),
  ],
  [
    'a mismatched external subject',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE auth_external_identities SET subject=? WHERE user_id=?')
          .run('wrong-linked-subject', f.userId),
      ),
  ],
  [
    'a mismatched external issuer',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE auth_external_identities SET issuer=? WHERE user_id=?')
          .run('https://untrusted.example.test', f.userId),
      ),
  ],
  [
    'a disabled PreMan user',
    (f) =>
      f.mutate((db) => db.prepare('UPDATE auth_users SET disabled=1 WHERE id=?').run(f.userId)),
  ],
  [
    'a local identity source',
    (f) =>
      f.mutate((db) =>
        db.prepare("UPDATE auth_users SET identity_source='local' WHERE id=?").run(f.userId),
      ),
  ],
  [
    'a PreMan user with a local password',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE auth_users SET password_hash='unexpected-local-password' WHERE id=?")
          .run(f.userId),
      ),
  ],
  [
    'a missing current membership',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('DELETE FROM auth_workspace_members WHERE user_id=? AND workspace_id=?')
          .run(f.userId, f.target),
      ),
  ],
  [
    'a disabled current membership',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            'UPDATE auth_workspace_members SET disabled=1 WHERE user_id=? AND workspace_id=?',
          )
          .run(f.userId, f.target),
      ),
  ],
  [
    'a downgraded member role',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "UPDATE auth_workspace_members SET role='editor' WHERE user_id=? AND workspace_id=?",
          )
          .run(f.userId, f.target),
      ),
  ],
  [
    'a project-scoped current membership',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "UPDATE auth_workspace_members SET projects_json='[]' WHERE user_id=? AND workspace_id=?",
          )
          .run(f.userId, f.target),
      ),
  ],
  [
    'a locally managed current membership',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "UPDATE auth_workspace_members SET source='local' WHERE user_id=? AND workspace_id=?",
          )
          .run(f.userId, f.target),
      ),
  ],
  [
    'an additional local target member',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,'admin','null','local')",
          )
          .run(LEGACY_USER, f.target),
      ),
  ],
  [
    'a conflicting legacy membership for the same PreMan user',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,'admin','null','preman')",
          )
          .run(f.userId, LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'an already-bound legacy workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE workspaces SET preman_issuer=?,preman_tenant_id=? WHERE id=?')
          .run(PREMAN_ISSUER, OTHER_TENANT, LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'a PreMan key already in the legacy workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE api_keys SET identity_source='preman' WHERE workspace_id=?")
          .run(LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'a PreMan membership already in the legacy workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE auth_workspace_members SET source='preman' WHERE workspace_id=?")
          .run(LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'a PreMan session already in the legacy workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE auth_sessions SET auth_method='preman' WHERE workspace_id=?")
          .run(LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'a missing legacy workspace',
    (f) =>
      f.mutate((db) => {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare('DELETE FROM workspaces WHERE id=?').run(LEGACY_WORKSPACE_ID);
      }),
  ],
  [
    'an unbound target workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE workspaces SET preman_issuer=NULL,preman_tenant_id=NULL WHERE id=?')
          .run(f.target),
      ),
  ],
  [
    'an untrusted target issuer',
    (f) =>
      f.mutate((db) =>
        db
          .prepare('UPDATE workspaces SET preman_issuer=? WHERE id=?')
          .run('https://untrusted.example.test', f.target),
      ),
  ],
  [
    'an invalid target tenant ID',
    (f) =>
      f.mutate((db) =>
        db.prepare("UPDATE workspaces SET preman_tenant_id='not-a-uuid' WHERE id=?").run(f.target),
      ),
  ],
  ['a schema older than version 4', (f) => f.mutate((db) => db.exec('PRAGMA user_version=3'))],
  ['a schema newer than version 4', (f) => f.mutate((db) => db.exec('PRAGMA user_version=5'))],
  [
    'no successful login audit',
    (f) =>
      f.mutate((db) =>
        db.prepare("DELETE FROM audit_events WHERE action='auth.preman.login'").run(),
      ),
  ],
  [
    'a stale successful login audit',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE audit_events SET at=? WHERE action='auth.preman.login'")
          .run(new Date(Date.now() - 600_000).toISOString()),
      ),
  ],
  [
    'a future successful login audit',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE audit_events SET at=? WHERE action='auth.preman.login'")
          .run(new Date(Date.now() + 60_000).toISOString()),
      ),
  ],
  [
    'a failed login audit',
    (f) =>
      f.mutate((db) =>
        db
          .prepare(
            "UPDATE audit_events SET outcome='failure',status_code=401 WHERE action='auth.preman.login'",
          )
          .run(),
      ),
  ],
  [
    'a login audit for another actor',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE audit_events SET actor_id=? WHERE action='auth.preman.login'")
          .run(LEGACY_USER),
      ),
  ],
  [
    'a login audit for another workspace',
    (f) =>
      f.mutate((db) =>
        db
          .prepare("UPDATE audit_events SET workspace_id=? WHERE action='auth.preman.login'")
          .run(LEGACY_WORKSPACE_ID),
      ),
  ],
  [
    'a trigger on a rewritten workspace reference',
    (f) =>
      f.mutate((db) =>
        db.exec(
          'CREATE TRIGGER unreviewed_membership_trigger AFTER UPDATE ON auth_workspace_members BEGIN DELETE FROM api_keys; END',
        ),
      ),
  ],
  [
    'an unexpected table referring to the target workspace',
    (f) =>
      f.mutate((db) => {
        db.exec(
          'CREATE TABLE unreviewed_workspace_data(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id))',
        );
        db.prepare('INSERT INTO unreviewed_workspace_data VALUES(?,?)').run(
          'must-not-discard',
          f.target,
        );
      }),
  ],
  [
    'an unexpected workspace reference without a foreign key',
    (f) =>
      f.mutate((db) => {
        db.exec('CREATE TABLE unreviewed_workspace_data(id TEXT PRIMARY KEY,workspace_id TEXT)');
        db.prepare('INSERT INTO unreviewed_workspace_data VALUES(?,?)').run(
          'must-not-discard',
          f.target,
        );
      }),
  ],
  [
    'an unexpected mixed-case workspace foreign key with cascading deletion',
    (f) =>
      f.mutate((db) => {
        db.exec(
          'CREATE TABLE unreviewed_workspace_data(id TEXT PRIMARY KEY,tenant TEXT REFERENCES WORKSPACES(id) ON DELETE CASCADE)',
        );
        db.prepare('INSERT INTO unreviewed_workspace_data VALUES(?,?)').run(
          'must-not-discard',
          f.target,
        );
      }),
  ],
  [
    'an extra cascading workspace foreign key inside an allowed table',
    (f) =>
      f.mutate((db) => {
        db.exec(
          'ALTER TABLE api_keys ADD COLUMN extra_workspace TEXT REFERENCES workspaces(id) ON DELETE CASCADE',
        );
        db.prepare('UPDATE api_keys SET extra_workspace=? WHERE id=?').run(
          f.target,
          'preserved-key',
        );
      }),
  ],
  [
    'an unknown table with a cascading composite membership foreign key',
    (f) =>
      f.mutate((db) => {
        db.exec(
          'CREATE TABLE unreviewed_data(member_user TEXT,member_workspace TEXT,payload TEXT,FOREIGN KEY(member_user,member_workspace) REFERENCES auth_workspace_members(user_id,workspace_id) ON UPDATE CASCADE)',
        );
        db.prepare('INSERT INTO unreviewed_data VALUES(?,?,?)').run(
          f.userId,
          f.target,
          'Target-owned data must not follow a membership into the legacy workspace',
        );
      }),
  ],
];

for (const [reason, mutate] of refusedCases) {
  test(`offline binding refuses ${reason} without changing the database`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assertRefused(f);
  });
}

test('offline binding refuses a member-only PreMan login', async (t) => {
  const f = await fixture(t, 'member');
  await assertRefused(f);
});

test('offline binding requires an exact, existing, nonlegacy internal workspace UUID', async (t) => {
  const f = await fixture(t);
  for (const selected of [LEGACY_WORKSPACE_ID, randomUUID(), TENANT, 'not-a-uuid']) {
    await assertRefused(f, selected);
  }
  await assertRefused(f, f.target, ['unexpected-argument']);
});

test('offline binding refuses while the service writer lock is held and succeeds after release', async (t) => {
  const f = await fixture(t);
  const release = acquireProcessLock(f.path + '.lock');
  try {
    await assertRefused(f);
  } finally {
    release();
  }
  const result = await f.cli();
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const provisioned of [false, true]) {
  test(`private-proof binding ${provisioned ? 'still refuses an already provisioned tenant' : 'still binds an unprovisioned tenant'}`, async (t) => {
    const f = await fixture(t);
    if (!provisioned) {
      f.mutate((db) => {
        for (const table of ['auth_sessions', 'auth_workspace_members', 'audit_events']) {
          db.prepare(`DELETE FROM ${quote(table)} WHERE workspace_id=?`).run(f.target);
        }
        db.prepare('DELETE FROM workspaces WHERE id=?').run(f.target);
      });
    }
    const proof = { code: randomBytes(32).toString('base64url'), code_verifier: 'v'.repeat(43) };
    const proofFile = join(f.directory, 'private-proof.json');
    await writeFile(proofFile, JSON.stringify(proof), { mode: 0o600 });
    const preload = join(f.directory, 'mock-private-proof-redemption.mjs');
    const identity: PremanIdentity = {
      issuer: PREMAN_ISSUER,
      subject: SUBJECT,
      tenant_kind: 'workbench_workspace',
      tenant_id: TENANT,
      tenant_name: 'Synthetic verified team',
      role: 'owner',
      email: 'binding-owner@example.test',
      email_verified: true,
      session_expires_at: new Date(Date.now() + 240_000).toISOString(),
    };
    // Replace fetch before importing the real CLI; no test request reaches the network.
    await writeFile(
      preload,
      `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, ${JSON.stringify(PREMAN_REDEEM_URL)});
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), ${JSON.stringify(proof)});
        return new Response(${JSON.stringify(JSON.stringify(identity))}, {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      };
    `,
    );
    const before = snapshot(f.path);
    const result = await f.run([proofFile], preload);
    if (provisioned) {
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(snapshot(f.path), before);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const after = snapshot(f.path);
      for (const [table, rows] of Object.entries(before.rows)) {
        if (table !== 'workspaces' && table !== 'audit_events') {
          assert.deepEqual(after.rows[table], rows, `${table} must remain unchanged`);
        }
      }
      withDatabase(f.path, (db) => {
        const legacy = db.prepare('SELECT * FROM workspaces WHERE id=?').get(LEGACY_WORKSPACE_ID)!;
        assert.equal(legacy.preman_issuer, PREMAN_ISSUER);
        assert.equal(legacy.preman_tenant_id, TENANT);
        assert.equal(legacy.name, identity.tenant_name);
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE action='workspace.bind.preman'",
            )
            .get()!.count,
          1,
        );
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      });
    }
    assert(!result.stdout.includes(proof.code) && !result.stderr.includes(proof.code));
    assert(
      !result.stdout.includes(proof.code_verifier) && !result.stderr.includes(proof.code_verifier),
    );
  });
}
