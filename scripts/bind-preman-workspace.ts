import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AccessController } from '../server/auth.ts';
import { acquireProcessLock, canonicalDatabasePath } from '../server/process-lock.ts';
import { parsePremanExchange, redeemPremanCode, validatePremanIdentity } from '../server/preman.ts';
import { LEGACY_WORKSPACE_ID, Store } from '../server/store.ts';

// Operator-only, offline migration. Proof is a short-lived launch code plus PKCE verifier,
// read from a private file; never accept a subject, email, role, or target tenant on trust.
const [database, proofFile, ...extra] = process.argv.slice(2);
if (!database || !proofFile || extra.length)
  throw new Error(
    'Usage: node --import tsx scripts/bind-preman-workspace.ts DATABASE PRIVATE_PROOF_FILE',
  );
process.umask(0o077);
let release: (() => void) | undefined;
let store: Store | undefined;
try {
  const proofPath = resolve(proofFile);
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
  console.log(
    'Existing workspace explicitly bound to the verified PreMan workspace. Project IDs and credentials are unchanged.',
  );
} catch {
  // Upstream payloads and proof contents must never appear in command output.
  console.error(
    'Workspace binding failed. Confirm the private proof is fresh, the service is stopped, and neither workspace is already bound or provisioned. No automatic merge is performed.',
  );
  process.exitCode = 1;
} finally {
  store?.close();
  release?.();
}
