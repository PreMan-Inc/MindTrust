import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';

test('a persisted v3 database migrates users, live sessions, API keys, audit, and project IDs without claiming a PreMan tenant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verus-v3-migration-'));
  const path = join(directory, 'workspace.sqlite');
  const old = new Store(path);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const cookie = 'd'.repeat(64);
  const key = 'fixture-existing-v3-api-key';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  old.put(
    'project',
    { id: 'stable-project', name: 'Existing project', description: '', createdAt },
    'stable-project',
  );
  old.db.exec(`
    DROP TABLE project_workspaces;
    DROP TABLE workspaces;
    CREATE TABLE auth_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,projects_json TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,allow_oidc INTEGER NOT NULL DEFAULT 0,oidc_issuer TEXT,oidc_subject TEXT);
    CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),token_hash TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE audit_events(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,actor_kind TEXT NOT NULL,action TEXT NOT NULL,project_id TEXT,outcome TEXT NOT NULL,status_code INTEGER NOT NULL);
    ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'editor';
    ALTER TABLE api_keys ADD COLUMN projects_json TEXT NOT NULL DEFAULT 'null';
    ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
    ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;
    ALTER TABLE api_keys ADD COLUMN created_by TEXT;
    PRAGMA user_version=3;
  `);
  old.db
    .prepare(
      'INSERT INTO auth_users(id,email,name,password_hash,role,projects_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'stable-user',
      'existing@example.test',
      'Existing user',
      'fixture-hash-preserved',
      'editor',
      '["stable-project"]',
      createdAt,
      createdAt,
    );
  old.db
    .prepare(
      'INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
    )
    .run('stable-session', 'stable-user', digest(cookie), expiresAt, createdAt);
  old.db
    .prepare(
      'INSERT INTO api_keys(id,name,prefix,hash,created_at,role,projects_json,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'stable-key',
      'Existing key',
      'fixture',
      digest(key),
      createdAt,
      'viewer',
      '["stable-project"]',
      expiresAt,
    );
  old.db
    .prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'stable-audit',
      createdAt,
      'stable-user',
      'user',
      'fixture.action',
      'stable-project',
      'success',
      200,
    );
  old.close();
  const instance = createApp({
    dbPath: path,
    seed: false,
    adminToken: 'fixture-bootstrap-recovery-token-with-32-characters',
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/auth/session`, {
      headers: { cookie: `mindtrust_session=${cookie}` },
    });
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.principal.id, 'stable-user');
    assert.equal(body.principal.workspaceId, 'legacy');
    assert.equal(body.expiresAt, expiresAt);
    const projects = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.deepEqual(
      (await projects.json()).map((project: { id: string }) => project.id),
      ['stable-project'],
    );
    const db = instance.store.db;
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      db.prepare('SELECT password_hash FROM auth_users WHERE id=?').get('stable-user')!
        .password_hash,
      'fixture-hash-preserved',
    );
    const preservedKey = db.prepare('SELECT * FROM api_keys WHERE id=?').get('stable-key')!;
    assert.equal(preservedKey.hash, digest(key));
    assert.equal(preservedKey.expires_at, expiresAt);
    assert.equal(preservedKey.workspace_id, 'legacy');
    assert.equal(
      db.prepare('SELECT workspace_id FROM audit_events WHERE id=?').get('stable-audit')!
        .workspace_id,
      'legacy',
    );
    assert.equal(
      db.prepare('SELECT preman_tenant_id FROM workspaces WHERE id=?').get('legacy')!
        .preman_tenant_id,
      null,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});
