import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccessController } from '../server/auth.ts';
import { acquireProcessLock, canonicalDatabasePath } from '../server/process-lock.ts';
import {
  parsePremanExchange,
  PREMAN_ISSUER,
  redeemPremanCode,
  validatePremanIdentity,
} from '../server/preman.ts';
import { LEGACY_WORKSPACE_ID, Store } from '../server/store.ts';

// Operator-only, offline migration. Authority comes from a verified launch proof or
// an existing server-verified session, never an email or caller-supplied identity.
const [database, modeOrProof, targetId, ...extra] = process.argv.slice(2);
const existingMode = modeOrProof === '--existing-workspace';
if (!database || !modeOrProof || extra.length || (existingMode ? !targetId : !!targetId))
  throw new Error(
    'Usage: node --import tsx scripts/bind-preman-workspace.ts DATABASE PRIVATE_PROOF_FILE | DATABASE --existing-workspace INTERNAL_WORKSPACE_UUID',
  );

function bindEmptyExistingWorkspace(db: DatabaseSync, workspaceId: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(workspaceId) || workspaceId === LEGACY_WORKSPACE_ID)
    throw new Error('An exact nonlegacy workspace UUID is required');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get()!.user_version !== 4)
      throw new Error('Existing-workspace binding requires schema 4');
    const references = new Set([
      'project_workspaces',
      'auth_workspace_members',
      'auth_sessions',
      'api_keys',
      'audit_events',
    ]);
    const rewritten = new Set(['auth_workspace_members', 'auth_sessions', 'audit_events']);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[];
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as {
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        seq: number;
      }[];
      const workspaceKeys = foreignKeys.filter((key) => key.table.toLowerCase() === 'workspaces');
      if (foreignKeys.some((key) => rewritten.has(key.table.toLowerCase())))
        throw new Error('Unexpected identity references require a separate migration');
      if (
        (columns.some((column) => column.name.toLowerCase() === 'workspace_id') ||
          workspaceKeys.length > 0) &&
        !references.has(name.toLowerCase())
      )
        throw new Error('Unknown workspace references require a separate migration');
      if (
        references.has(name.toLowerCase()) &&
        (workspaceKeys.length !== 1 ||
          workspaceKeys[0].from.toLowerCase() !== 'workspace_id' ||
          workspaceKeys[0].to.toLowerCase() !== 'id' ||
          workspaceKeys[0].seq !== 0 ||
          workspaceKeys[0].on_update !== 'NO ACTION' ||
          workspaceKeys[0].on_delete !== 'NO ACTION')
      )
        throw new Error('Unexpected workspace foreign keys require a separate migration');
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1").get())
      throw new Error('Database triggers require a separately reviewed migration');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Database references are inconsistent');

    const legacy = db
      .prepare('SELECT preman_issuer,preman_tenant_id FROM workspaces WHERE id=?')
      .get(LEGACY_WORKSPACE_ID);
    if (!legacy || legacy.preman_issuer !== null || legacy.preman_tenant_id !== null)
      throw new Error('Only an unbound legacy workspace can be attached');
    if (
      db
        .prepare(
          "SELECT 1 FROM auth_workspace_members WHERE workspace_id=? AND source<>'local' LIMIT 1",
        )
        .get(LEGACY_WORKSPACE_ID) ||
      db
        .prepare(
          "SELECT 1 FROM auth_sessions WHERE workspace_id=? AND auth_method='preman' LIMIT 1",
        )
        .get(LEGACY_WORKSPACE_ID) ||
      db
        .prepare("SELECT 1 FROM api_keys WHERE workspace_id=? AND identity_source<>'local' LIMIT 1")
        .get(LEGACY_WORKSPACE_ID)
    )
      throw new Error('Legacy already contains PreMan authority');
    const target = db.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId) as
      { id: string; name: string; preman_issuer: string; preman_tenant_id: string } | undefined;
    if (
      !target ||
      target.preman_issuer !== PREMAN_ISSUER ||
      !uuid.test(target.preman_tenant_id) ||
      !target.name.trim()
    )
      throw new Error('Target is not a verified PreMan workspace');
    if (
      db
        .prepare('SELECT 1 FROM project_workspaces WHERE workspace_id=? LIMIT 1')
        .get(workspaceId) ||
      db.prepare('SELECT 1 FROM api_keys WHERE workspace_id=? LIMIT 1').get(workspaceId) ||
      db
        .prepare(
          'SELECT 1 FROM records r LEFT JOIN project_workspaces p ON p.project_id=r.project_id WHERE p.project_id IS NULL LIMIT 1',
        )
        .get()
    )
      throw new Error('Only a target with no data or keys can be attached');
    const members = db
      .prepare(
        'SELECT m.*,u.identity_source,u.password_hash,u.disabled AS user_disabled,u.allow_oidc,u.oidc_issuer,u.oidc_subject,e.issuer,e.subject FROM auth_workspace_members m JOIN auth_users u ON u.id=m.user_id LEFT JOIN auth_external_identities e ON e.user_id=u.id WHERE m.workspace_id=?',
      )
      .all(workspaceId) as {
      user_id: string;
      source: string;
      role: string;
      projects_json: string;
      disabled: number;
      identity_source: string;
      password_hash: string | null;
      user_disabled: number;
      allow_oidc: number;
      oidc_issuer: string | null;
      oidc_subject: string | null;
      issuer: string;
      subject: string;
    }[];
    if (!members.length) throw new Error('Target has no verified membership');
    const byUser = new Map(members.map((member) => [member.user_id, member]));
    for (const member of members) {
      if (
        member.source !== 'preman' ||
        member.identity_source !== 'preman' ||
        member.disabled !== 0 ||
        member.user_disabled !== 0 ||
        !['admin', 'editor'].includes(member.role) ||
        JSON.parse(member.projects_json) !== null ||
        member.password_hash !== null ||
        member.allow_oidc !== 0 ||
        member.oidc_issuer !== null ||
        member.oidc_subject !== null ||
        member.issuer !== PREMAN_ISSUER ||
        typeof member.subject !== 'string' ||
        !member.subject.length ||
        member.subject.length > 200 ||
        db
          .prepare('SELECT 1 FROM auth_workspace_members WHERE user_id=? AND workspace_id=?')
          .get(member.user_id, LEGACY_WORKSPACE_ID)
      )
        throw new Error('Target identities cannot be safely consolidated');
    }
    const now = Date.now();
    let verifiedAdministrator = false;
    const sessions = db
      .prepare('SELECT * FROM auth_sessions WHERE workspace_id=?')
      .all(workspaceId) as {
      user_id: string;
      auth_method: string;
      upstream_identity_json: string | null;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
    }[];
    for (const session of sessions) {
      const member = byUser.get(session.user_id);
      const upstream = session.upstream_identity_json
        ? JSON.parse(session.upstream_identity_json)
        : null;
      const created = Date.parse(session.created_at);
      const expires = Date.parse(session.expires_at);
      if (
        session.auth_method !== 'preman' ||
        !member ||
        !upstream ||
        Object.keys(upstream).sort().join(',') !== 'issuer,subject,tenantId,tenantKind' ||
        upstream.issuer !== PREMAN_ISSUER ||
        upstream.subject !== member.subject ||
        upstream.tenantKind !== 'workbench_workspace' ||
        upstream.tenantId !== target.preman_tenant_id ||
        !Number.isFinite(created) ||
        !Number.isFinite(expires) ||
        created > now ||
        expires <= created ||
        expires > now + 300_000
      )
        throw new Error('Target contains an invalid PreMan session');
      if (session.revoked_at === null && expires > now && member.role === 'admin') {
        const audit = db
          .prepare(
            "SELECT at FROM audit_events WHERE workspace_id=? AND actor_id=? AND actor_kind='user' AND action='auth.preman.login' AND outcome='success' AND status_code=200 ORDER BY at DESC LIMIT 1",
          )
          .get(workspaceId, session.user_id) as { at: string } | undefined;
        const authorized = audit ? Date.parse(audit.at) : NaN;
        if (Number.isFinite(authorized) && authorized <= now && authorized > now - 300_000)
          verifiedAdministrator = true;
      }
    }
    if (!verifiedAdministrator)
      throw new Error('A fresh live PreMan administrator session is required');
    if (
      db
        .prepare(
          'SELECT 1 FROM audit_events WHERE workspace_id=? AND project_id IS NOT NULL LIMIT 1',
        )
        .get(workspaceId)
    )
      throw new Error('Target audit references data');

    // Keep legacy IDs, scopes, credentials, and sessions unchanged. Move only the
    // empty first-login shell's identity references, then transfer its tenant binding.
    for (const table of ['auth_workspace_members', 'auth_sessions', 'audit_events'])
      db.prepare(`UPDATE ${table} SET workspace_id=? WHERE workspace_id=?`).run(
        LEGACY_WORKSPACE_ID,
        workspaceId,
      );
    db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    db.prepare('UPDATE workspaces SET preman_issuer=?,preman_tenant_id=?,name=? WHERE id=?').run(
      target.preman_issuer,
      target.preman_tenant_id,
      target.name,
      LEGACY_WORKSPACE_ID,
    );
    db.prepare(
      'INSERT INTO audit_events(id,at,actor_id,actor_kind,action,project_id,outcome,status_code,workspace_id) VALUES(?,?,?,?,?,NULL,?,?,?)',
    ).run(
      randomUUID(),
      new Date().toISOString(),
      'operator-cli',
      'bootstrap',
      'workspace.bind.preman.existing',
      'success',
      200,
      LEGACY_WORKSPACE_ID,
    );
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Binding failed its foreign-key check');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

process.umask(0o077);
let release: (() => void) | undefined;
let store: Store | undefined;
let existingDatabase: DatabaseSync | undefined;
try {
  if (existingMode) {
    const path = canonicalDatabasePath(resolve(database));
    if (!(await lstat(path)).isFile()) throw new Error('An existing database file is required');
    release = acquireProcessLock(path + '.lock');
    existingDatabase = new DatabaseSync(path);
    bindEmptyExistingWorkspace(existingDatabase, targetId!);
  } else {
    const proofPath = resolve(modeOrProof);
    const info = await lstat(proofPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077) !== 0)
      throw new Error('Proof must be a regular private file of at most 4096 bytes');
    const path = canonicalDatabasePath(resolve(database));
    if (!(await lstat(path)).isFile()) throw new Error('An existing database file is required');
    const proof = parsePremanExchange(JSON.parse(await readFile(proofPath, 'utf8')));
    const identity = validatePremanIdentity(await redeemPremanCode(proof));
    if (!['owner', 'admin'].includes(identity.role))
      throw new Error('A verified PreMan workspace owner or administrator is required');
    release = acquireProcessLock(path + '.lock');
    store = new Store(path);
    new AccessController(store);
    const db = store.db;
    store.transaction(() => {
      validatePremanIdentity(identity);
      const legacy = db
        .prepare('SELECT preman_issuer,preman_tenant_id FROM workspaces WHERE id=?')
        .get(LEGACY_WORKSPACE_ID) as {
        preman_issuer: string | null;
        preman_tenant_id: string | null;
      };
      if (legacy.preman_issuer || legacy.preman_tenant_id)
        throw new Error('Existing workspace is already bound; rebinding is refused');
      if (
        db
          .prepare('SELECT id FROM workspaces WHERE preman_issuer=? AND preman_tenant_id=?')
          .get(identity.issuer, identity.tenant_id)
      )
        throw new Error(
          'Target PreMan workspace is already provisioned; use a separately reviewed migration instead of merging workspaces',
        );
      db.prepare('UPDATE workspaces SET preman_issuer=?,preman_tenant_id=?,name=? WHERE id=?').run(
        identity.issuer,
        identity.tenant_id,
        identity.tenant_name,
        LEGACY_WORKSPACE_ID,
      );
      db.prepare(
        'INSERT INTO audit_events(id,at,actor_id,actor_kind,action,project_id,outcome,status_code,workspace_id) VALUES(?,?,?,?,?,NULL,?,?,?)',
      ).run(
        randomUUID(),
        new Date().toISOString(),
        'operator-cli',
        'bootstrap',
        'workspace.bind.preman',
        'success',
        200,
        LEGACY_WORKSPACE_ID,
      );
    });
  }
  console.log(
    'Existing workspace explicitly bound to the verified PreMan workspace. Project IDs and credentials are unchanged.',
  );
} catch {
  // Upstream payloads and proof contents must never appear in command output.
  console.error(
    existingMode
      ? 'Workspace binding failed. Stop the service and confirm the exact target is empty, has a fresh verified PreMan administrator session, and the legacy workspace is unbound. No changes were applied.'
      : 'Workspace binding failed. Confirm the private proof is fresh, the service is stopped, and neither workspace is already bound or provisioned. No automatic merge is performed.',
  );
  process.exitCode = 1;
} finally {
  existingDatabase?.close();
  store?.close();
  release?.();
}
