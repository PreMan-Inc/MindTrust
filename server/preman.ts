import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AccessController, UpstreamIdentity } from './auth.ts';
import { HttpError, type Store } from './store.ts';
import { parse } from './validation.ts';

export const PREMAN_ISSUER = 'https://api.preman.live';
export const PREMAN_REDEEM_URL = 'https://api.preman.live/auth/verus/redeem';
export const PREMAN_WEB_ORIGIN = 'https://app.preman.live';
const exchangeSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export type PremanExchange = z.infer<typeof exchangeSchema>;
const identitySchema = z.strictObject({
  issuer: z.string().max(2048),
  subject: z.string().min(1).max(200),
  tenant_kind: z.literal('workbench_workspace'),
  tenant_id: z.string().uuid(),
  tenant_name: z.string().trim().min(1).max(200),
  role: z.enum(['owner', 'admin', 'member']),
  email: z.string().trim().toLowerCase().email().max(254),
  email_verified: z.literal(true),
  session_expires_at: z.string().datetime({ offset: true }),
});
export type PremanIdentity = z.infer<typeof identitySchema>;
export interface PremanOptions {
  issuer?: string;
  /** In-process integration-test transport only; production always uses the fixed HTTPS endpoint. */
  redeem?: (body: PremanExchange) => Promise<unknown>;
}
export function validatePremanIdentity(value: unknown, issuer = PREMAN_ISSUER): PremanIdentity {
  const identity = identitySchema.parse(value);
  const expires = Date.parse(identity.session_expires_at);
  if (identity.issuer !== issuer || expires <= Date.now() || expires > Date.now() + 300_000)
    throw new Error('PreMan identity has an invalid authority or expiration');
  return identity;
}
export function parsePremanExchange(value: unknown): PremanExchange {
  return exchangeSchema.parse(value);
}

export async function redeemPremanCode(body: PremanExchange): Promise<unknown> {
  const response = await fetch(PREMAN_REDEEM_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (
    !response.ok ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel();
    throw new Error('PreMan redemption failed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PreMan redemption returned no identity');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 16_384) throw new Error('PreMan identity response is too large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function mountPreman(
  app: Express,
  store: Store,
  access: AccessController,
  options: PremanOptions,
) {
  const issuer = options.issuer ?? PREMAN_ISSUER;
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('PreMan requires an exact trusted HTTPS issuer');
  if (access.production && options.redeem)
    throw new Error('Production cannot override the PreMan redemption transport');
  access.configurePreman();
  const redeem = options.redeem ?? redeemPremanCode;
  let pending = 0;
  app.post('/api/auth/preman/exchange', async (req, res) => {
    if (!req.is('application/json')) throw new HttpError(415, 'A JSON request is required');
    if (req.get('authorization'))
      throw new HttpError(400, 'Exchange accepts only a PreMan launch code');
    const body = parse(exchangeSchema, req.body);
    const now = Date.now();
    const hash = createHash('sha256').update(body.code).digest('hex');
    const ip = createHash('sha256')
      .update(req.ip ?? req.socket.remoteAddress ?? 'unknown')
      .digest('hex');
    const limitKey = `preman:${ip}`;
    store.db.prepare('DELETE FROM auth_login_limits WHERE reset_at<=?').run(now);
    const attempts = store.db
      .prepare('SELECT attempts FROM auth_login_limits WHERE key=?')
      .get(limitKey) as { attempts: number } | undefined;
    if ((attempts?.attempts ?? 0) >= 60 || pending >= 16)
      throw new HttpError(429, 'Too many sign-in attempts. Try again shortly.');
    store.db
      .prepare(
        'INSERT INTO auth_login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1',
      )
      .run(limitKey, now + 60_000);
    store.db.prepare('DELETE FROM auth_preman_exchanges WHERE expires_at<=?').run(now);
    const reserved = store.db
      .prepare('INSERT OR IGNORE INTO auth_preman_exchanges(code_hash,expires_at) VALUES(?,?)')
      .run(hash, now + 600_000);
    if (!reserved.changes) throw new HttpError(401, 'PreMan sign-in is invalid or expired');
    pending++;
    try {
      const identity = validatePremanIdentity(await redeem(body), issuer);
      const role = identity.role === 'member' ? 'editor' : 'admin';
      const resolved = store.transaction(() => {
        let workspace = store.db
          .prepare('SELECT id FROM workspaces WHERE preman_issuer=? AND preman_tenant_id=?')
          .get(issuer, identity.tenant_id) as { id: string } | undefined;
        if (!workspace) {
          workspace = { id: randomUUID() };
          store.db
            .prepare(
              'INSERT INTO workspaces(id,name,preman_issuer,preman_tenant_id,created_at) VALUES(?,?,?,?,?)',
            )
            .run(
              workspace.id,
              identity.tenant_name,
              issuer,
              identity.tenant_id,
              new Date().toISOString(),
            );
        }
        const linked = store.db
          .prepare('SELECT user_id FROM auth_external_identities WHERE issuer=? AND subject=?')
          .get(issuer, identity.subject) as { user_id: string } | undefined;
        const userId = linked?.user_id ?? randomUUID();
        if (!linked) {
          store.db
            .prepare(
              "INSERT INTO auth_users(id,email,name,password_hash,role,projects_json,created_at,updated_at,identity_source) VALUES(?,?,?,NULL,'viewer','[]',?,?,'preman')",
            )
            .run(
              userId,
              identity.email,
              identity.email,
              new Date().toISOString(),
              new Date().toISOString(),
            );
          store.db
            .prepare('INSERT INTO auth_external_identities(issuer,subject,user_id) VALUES(?,?,?)')
            .run(issuer, identity.subject, userId);
        } else {
          const user = store.db
            .prepare('SELECT disabled,identity_source FROM auth_users WHERE id=?')
            .get(userId) as { disabled: number; identity_source: string } | undefined;
          if (!user || user.disabled || user.identity_source !== 'preman')
            throw new Error('Identity is unavailable');
          store.db
            .prepare('UPDATE auth_users SET email=?,name=?,updated_at=? WHERE id=?')
            .run(identity.email, identity.email, new Date().toISOString(), userId);
        }
        store.db
          .prepare(
            "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,?,'null','preman') ON CONFLICT(user_id,workspace_id) DO UPDATE SET role=excluded.role WHERE source='preman'",
          )
          .run(userId, workspace.id, role);
        return { userId, workspaceId: workspace.id };
      });
      const upstreamIdentity: UpstreamIdentity = {
        issuer,
        subject: identity.subject,
        tenantKind: 'workbench_workspace',
        tenantId: identity.tenant_id,
      };
      const session = access.startUserSession(req, res, resolved.userId, {
        workspaceId: resolved.workspaceId,
        authMethod: 'preman',
        expiresAt: identity.session_expires_at,
        upstreamIdentity,
      });
      access.audit(req, 'auth.preman.login');
      res.json(session);
    } catch {
      access.audit(req, 'auth.preman.login', 401);
      throw new HttpError(401, 'PreMan sign-in is invalid or expired');
    } finally {
      pending--;
    }
  });
}
