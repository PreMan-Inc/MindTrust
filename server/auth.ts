import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Project } from '../shared/types.ts';
import { HttpError, LEGACY_WORKSPACE_ID, Store } from './store.ts';
import { idSchema, nameSchema, parse, positiveQuery } from './validation.ts';

export type Role = 'viewer' | 'editor' | 'admin';
export interface UpstreamIdentity {
  issuer: string;
  subject: string;
  tenantKind: 'workbench_workspace';
  tenantId: string;
}
export interface Principal {
  id: string;
  kind: 'user' | 'api-key' | 'bootstrap' | 'development';
  role: Role;
  projectIds: string[] | null;
  name: string;
  email?: string;
  workspaceId: string;
  authMethod?: 'local' | 'oidc' | 'preman';
}
export interface AccessOptions {
  adminToken?: string;
  production?: boolean;
  sessionTtlMs?: number;
  loginMaxAttempts?: number;
  loginWindowMs?: number;
}
interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: Role;
  projects_json: string;
  disabled: number;
  allow_oidc: number;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  created_at: string;
  updated_at: string;
  identity_source: 'local' | 'preman';
}
interface MembershipRecord {
  user_id: string;
  workspace_id: string;
  role: Role;
  projects_json: string;
  disabled: number;
  source: 'local' | 'preman';
}
interface SessionRecord {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
  workspace_id: string;
  auth_method: 'local' | 'oidc' | 'preman';
  upstream_identity_json: string | null;
}
interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: string;
  role: Role;
  projects_json: string;
  expires_at: string;
  revoked_at: string | null;
  workspace_id: string;
  identity_source: 'local' | 'preman';
}
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  projectIds: string[] | null;
  disabled: boolean;
  allowOidc: boolean;
  oidcLinked: boolean;
  createdAt: string;
  updatedAt: string;
  managedBy?: 'preman';
}
export interface TeamApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  role: Role;
  projectIds: string[] | null;
  expiresAt: string;
  revokedAt: string | null;
}
const roles = z.enum(['viewer', 'editor', 'admin']);
const scopes = z.array(idSchema).max(1000).nullable();
const passwordSchema = z.string().min(12).max(256);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const at = () => new Date().toISOString();
const live = (expiresAt: string) =>
  Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now();
const cookieName = 'mindtrust_session';
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const publicUser = (u: UserRecord): TeamUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  projectIds: JSON.parse(u.projects_json),
  disabled: !!u.disabled,
  allowOidc: !!u.allow_oidc,
  oidcLinked: !!u.oidc_subject,
  createdAt: u.created_at,
  updatedAt: u.updated_at,
  ...(u.identity_source === 'preman' ? { managedBy: 'preman' as const } : {}),
});
const publicKey = (k: KeyRecord): TeamApiKey => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.created_at,
  role: k.role,
  projectIds: JSON.parse(k.projects_json),
  expiresAt: k.expires_at,
  revokedAt: k.revoked_at,
});
const passwordCapacity = { active: 0, queued: [] as (() => void)[] };
export function passwordWorkStats() {
  return {
    active: passwordCapacity.active,
    queued: passwordCapacity.queued.length,
    maxActive: 4,
    maxQueued: 32,
  };
}
async function derive(password: string, salt: string): Promise<Buffer> {
  if (passwordCapacity.active >= 4) {
    if (passwordCapacity.queued.length >= 32)
      throw new HttpError(503, 'Authentication is busy. Try again shortly.');
    await new Promise<void>((resolve) => passwordCapacity.queued.push(resolve));
  } else passwordCapacity.active++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    const next = passwordCapacity.queued.shift();
    if (next) next();
    else passwordCapacity.active--;
  }
}
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, salt, expected] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    n !== '32768' ||
    r !== '8' ||
    p !== '1' ||
    !salt ||
    !expected ||
    expected.length !== 128
  )
    return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function bearer(req: Request) {
  const header = req.get('authorization');
  if (!header) return undefined;
  if (!header.startsWith('Bearer ') || !header.slice(7).trim())
    throw new HttpError(401, 'Invalid authorization header');
  return header.slice(7).trim();
}
function sessionCookie(req: Request) {
  const raw = req.get('cookie');
  if (!raw) return undefined;
  const entries = raw
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${cookieName}=`));
  if (entries.length !== 1) return undefined;
  const token = entries[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

/** One isolated customer workspace. Every request is authorized against current DB permissions. */
export class AccessController {
  readonly production: boolean;
  private readonly adminToken: string;
  private readonly sessionTtlMs: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowMs: number;
  private readonly principals = new WeakMap<Request, Principal>();
  private readonly sessions = new WeakMap<
    Request,
    { id: string; csrfToken: string; expiresAt: string; upstreamIdentity?: UpstreamIdentity }
  >();
  private readonly projects = new WeakMap<Request, string>();
  private oidcDisplay: { label: string; loginUrl: string } | undefined;
  private premanDisplay: { loginUrl: string } | undefined;
  configurePreman() {
    this.premanDisplay = { loginUrl: 'https://app.preman.live/workbench/verus' };
  }
  configureOidc(label: string) {
    this.oidcDisplay = { label, loginUrl: '/api/auth/oidc/login' };
  }
  constructor(
    readonly store: Store,
    options: AccessOptions = {},
  ) {
    this.production = options.production ?? false;
    this.adminToken = options.adminToken ?? '';
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
    this.loginMaxAttempts = options.loginMaxAttempts ?? 10;
    this.loginWindowMs = options.loginWindowMs ?? 15 * 60 * 1000;
    if (
      !Number.isInteger(this.sessionTtlMs) ||
      this.sessionTtlMs < 1000 ||
      this.sessionTtlMs > 24 * 60 * 60 * 1000
    )
      throw new Error('Session TTL must be between 1 second and 24 hours');
    if (
      !Number.isInteger(this.loginMaxAttempts) ||
      this.loginMaxAttempts < 1 ||
      this.loginMaxAttempts > 100 ||
      !Number.isInteger(this.loginWindowMs) ||
      this.loginWindowMs < 1000
    )
      throw new Error('Invalid login rate-limit configuration');
    this.migrate();
    if (this.production && this.adminToken.length < 32)
      throw new Error(
        'Production requires a bootstrap/recovery admin token of at least 32 characters',
      );
  }
  private migrate() {
    this.store.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this.store.transaction(() => {
        const columns = new Set(
          (this.store.db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
        for (const [name, definition] of [
          ['role', "TEXT NOT NULL DEFAULT 'editor'"],
          ['projects_json', "TEXT NOT NULL DEFAULT 'null'"],
          ['expires_at', 'TEXT'],
          ['revoked_at', 'TEXT'],
          ['created_by', 'TEXT'],
        ])
          if (!columns.has(name))
            this.store.db.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${definition}`);
        // Legacy keys retain editor access for a bounded migration window; never inherit admin.
        this.store.db
          .prepare('UPDATE api_keys SET expires_at=? WHERE expires_at IS NULL')
          .run(new Date(Date.now() + 30 * 86400000).toISOString());
        this.store.db
          .exec(`CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),projects_json TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),token_hash TEXT UNIQUE NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
        CREATE TABLE IF NOT EXISTS auth_login_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,actor_kind TEXT NOT NULL,action TEXT NOT NULL,project_id TEXT,outcome TEXT NOT NULL,status_code INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(at);`);
        const userColumns = new Set(
          (this.store.db.prepare('PRAGMA table_info(auth_users)').all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
        for (const [name, definition] of [
          ['allow_oidc', 'INTEGER NOT NULL DEFAULT 0'],
          ['oidc_issuer', 'TEXT'],
          ['oidc_subject', 'TEXT'],
        ])
          if (!userColumns.has(name))
            this.store.db.exec(`ALTER TABLE auth_users ADD COLUMN ${name} ${definition}`);
        this.store.db.exec(
          'CREATE UNIQUE INDEX IF NOT EXISTS auth_user_oidc ON auth_users(oidc_issuer,oidc_subject) WHERE oidc_subject IS NOT NULL',
        );
        if (!userColumns.has('identity_source')) {
          // Rebuild once to permit passwordless identities and identical display emails
          // from different authorities, while keeping local-login email uniqueness.
          this.store.db.exec(`
          CREATE TABLE auth_users_v4(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,password_hash TEXT,role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),projects_json TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,allow_oidc INTEGER NOT NULL DEFAULT 0,oidc_issuer TEXT,oidc_subject TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,identity_source TEXT NOT NULL DEFAULT 'local' CHECK(identity_source IN ('local','preman')));
          INSERT INTO auth_users_v4(id,email,name,password_hash,role,projects_json,disabled,allow_oidc,oidc_issuer,oidc_subject,created_at,updated_at) SELECT id,email,name,password_hash,role,projects_json,disabled,allow_oidc,oidc_issuer,oidc_subject,created_at,updated_at FROM auth_users;
          DROP TABLE auth_users;
          ALTER TABLE auth_users_v4 RENAME TO auth_users;
        `);
        }
        this.store.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS auth_local_email ON auth_users(email) WHERE identity_source='local';
        CREATE UNIQUE INDEX IF NOT EXISTS auth_user_oidc ON auth_users(oidc_issuer,oidc_subject) WHERE oidc_subject IS NOT NULL;
        CREATE TABLE IF NOT EXISTS auth_external_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES auth_users(id),PRIMARY KEY(issuer,subject),UNIQUE(user_id));
        CREATE TABLE IF NOT EXISTS auth_workspace_members(user_id TEXT NOT NULL REFERENCES auth_users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),projects_json TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL CHECK(source IN ('local','preman')),PRIMARY KEY(user_id,workspace_id));
        CREATE TABLE IF NOT EXISTS auth_preman_exchanges(code_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      `);
        for (const [table, name, definition] of [
          [
            'auth_sessions',
            'workspace_id',
            "TEXT NOT NULL DEFAULT 'legacy' REFERENCES workspaces(id)",
          ],
          ['auth_sessions', 'auth_method', "TEXT NOT NULL DEFAULT 'local'"],
          ['auth_sessions', 'upstream_identity_json', 'TEXT'],
          ['api_keys', 'workspace_id', "TEXT NOT NULL DEFAULT 'legacy' REFERENCES workspaces(id)"],
          ['api_keys', 'identity_source', "TEXT NOT NULL DEFAULT 'local'"],
          [
            'audit_events',
            'workspace_id',
            "TEXT NOT NULL DEFAULT 'legacy' REFERENCES workspaces(id)",
          ],
        ]) {
          const columns = this.store.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[];
          if (!columns.some((column) => column.name === name))
            this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO auth_workspace_members(user_id,workspace_id,role,projects_json,disabled,source) SELECT id,?,role,projects_json,disabled,'local' FROM auth_users WHERE identity_source='local'",
          )
          .run(LEGACY_WORKSPACE_ID);
        if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('Authentication migration failed its foreign-key check');
        this.store.db.exec('PRAGMA user_version=4');
      });
    } finally {
      this.store.db.exec('PRAGMA foreign_keys=ON');
    }
  }
  get enabled() {
    return (
      this.production ||
      !!this.adminToken ||
      !!this.store.db.prepare('SELECT id FROM auth_users LIMIT 1').get()
    );
  }
  audit(req: Request | undefined, action: string, statusCode = 200) {
    const p = req ? this.principals.get(req) : undefined;
    this.store.db
      .prepare(
        'INSERT INTO audit_events(id,at,actor_id,actor_kind,action,project_id,outcome,status_code,workspace_id) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        at(),
        p?.id ?? null,
        p?.kind ?? 'anonymous',
        action,
        req ? (this.projects.get(req) ?? null) : null,
        statusCode < 400 ? 'success' : 'denied',
        statusCode,
        p?.workspaceId ?? LEGACY_WORKSPACE_ID,
      );
  }
  auditMiddleware = (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
      // Route templates omit arbitrary IDs and query strings. Never record bodies or headers.
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      if (!/^\/(api|v1|object|logs3|btql)/.test(req.originalUrl.split('?')[0])) return;
      try {
        this.audit(req, `http.${req.method}.${route}`, res.statusCode);
      } catch {
        console.error('Unable to append audit event');
      }
    });
    next();
  };
  authenticate(req: Request) {
    if (this.principals.has(req)) return;
    const token = bearer(req);
    if (token) {
      if (this.adminToken && safeEqual(token, this.adminToken)) {
        this.principals.set(req, {
          id: 'bootstrap',
          kind: 'bootstrap',
          role: 'admin',
          projectIds: null,
          name: 'Bootstrap administrator',
          workspaceId: LEGACY_WORKSPACE_ID,
        });
        return;
      }
      const key = this.store.db.prepare('SELECT * FROM api_keys WHERE hash=?').get(sha(token)) as
        KeyRecord | undefined;
      if (!key || key.revoked_at || !live(key.expires_at))
        throw new HttpError(401, 'Credential is invalid, expired, or revoked');
      this.principals.set(req, {
        id: key.id,
        kind: 'api-key',
        role: key.role,
        projectIds: JSON.parse(key.projects_json),
        name: key.name,
        workspaceId: key.workspace_id,
        ...(key.identity_source === 'preman' ? { authMethod: 'preman' as const } : {}),
      });
      return;
    }
    const cookie = sessionCookie(req);
    if (cookie) {
      const session = this.store.db
        .prepare('SELECT * FROM auth_sessions WHERE token_hash=?')
        .get(sha(cookie)) as SessionRecord | undefined;
      if (!session || session.revoked_at || !live(session.expires_at))
        throw new HttpError(401, 'Session is invalid or expired');
      const user = this.store.db
        .prepare('SELECT * FROM auth_users WHERE id=?')
        .get(session.user_id) as UserRecord | undefined;
      if (!user || user.disabled) throw new HttpError(401, 'Session is invalid or expired');
      const membership = this.membership(user.id, session.workspace_id);
      if (!membership || membership.disabled)
        throw new HttpError(401, 'Workspace access is unavailable');
      const csrfToken = createHmac('sha256', cookie).update('mindtrust-csrf-v1').digest('hex');
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !safeEqual(req.get('x-csrf-token') ?? '', csrfToken)
      )
        throw new HttpError(403, 'A valid X-CSRF-Token is required for session mutations');
      this.principals.set(req, {
        id: user.id,
        kind: 'user',
        role: membership.role,
        projectIds: JSON.parse(membership.projects_json),
        name: user.name,
        email: user.email,
        workspaceId: session.workspace_id,
        authMethod: session.auth_method,
      });
      this.sessions.set(req, {
        id: session.id,
        csrfToken,
        expiresAt: session.expires_at,
        ...(session.upstream_identity_json
          ? { upstreamIdentity: JSON.parse(session.upstream_identity_json) as UpstreamIdentity }
          : {}),
      });
      return;
    }
    if (!this.enabled) {
      this.principals.set(req, {
        id: 'local-development',
        kind: 'development',
        role: 'admin',
        projectIds: null,
        name: 'Local development',
        workspaceId: LEGACY_WORKSPACE_ID,
      });
      return;
    }
    throw new HttpError(401, 'Sign in or provide a valid Bearer token');
  }
  middleware = (req: Request, _res: Response, next: NextFunction) => {
    try {
      this.authenticate(req);
      next();
    } catch (error) {
      next(error);
    }
  };
  principal(req: Request): Principal {
    this.authenticate(req);
    return this.principals.get(req)!;
  }
  requireAdmin(req: Request) {
    const p = this.principal(req);
    if (p.role !== 'admin' || p.projectIds !== null)
      throw new HttpError(403, 'Workspace administrator access is required');
  }
  requireOperator(req: Request) {
    if (!['bootstrap', 'development'].includes(this.principal(req).kind))
      throw new HttpError(403, 'Deployment operator access is required');
  }
  workspaceId(req: Request) {
    return this.principal(req).workspaceId;
  }
  createProject(req: Request, project: Project) {
    this.requireCreateProject(req);
    return this.store.createProject(project, this.workspaceId(req));
  }
  requireCreateProject(req: Request) {
    this.requireAdmin(req);
  }
  requireProject(req: Request, projectId: string, mode: 'read' | 'write') {
    const p = this.principal(req);
    if (this.store.projectWorkspace(projectId) !== p.workspaceId)
      throw new HttpError(403, 'Access to this project is not allowed');
    if (p.projectIds !== null && !p.projectIds.includes(projectId))
      throw new HttpError(403, 'Access to this project is not allowed');
    if (mode === 'write' && p.role === 'viewer')
      throw new HttpError(403, 'This credential has read-only access');
    this.store.project(projectId);
    this.projects.set(req, projectId);
  }
  filterProjects(req: Request, projects: Project[]) {
    const p = this.principal(req);
    return projects.filter(
      (project) =>
        this.store.projectWorkspace(project.id) === p.workspaceId &&
        (p.projectIds === null || p.projectIds.includes(project.id)),
    );
  }
  listProjects(req: Request) {
    return this.filterProjects(req, this.store.list<Project>('project'));
  }
  requireResource(
    req: Request,
    kind: 'trace' | 'dataset' | 'experiment' | 'prompt' | 'scorer' | 'case',
    id: string,
    mode: 'read' | 'write',
  ) {
    const resource = this.store.get<{ projectId?: string; experimentId?: string }>(kind, id);
    if (!resource) throw new HttpError(404, 'Resource not found');
    const projectId =
      kind === 'case'
        ? this.store.get<{ projectId: string }>('experiment', resource.experimentId!)?.projectId
        : resource.projectId;
    if (!projectId) throw new HttpError(404, 'Resource not found');
    this.requireProject(req, projectId, mode);
    return projectId;
  }
  private validateScope(role: Role, projectIds: string[] | null, workspaceId: string) {
    if (role === 'admin' && projectIds !== null)
      throw new HttpError(400, 'Administrator role requires all-project access');
    if (projectIds !== null) {
      if (new Set(projectIds).size !== projectIds.length)
        throw new HttpError(400, 'Duplicate project IDs');
      for (const id of projectIds) {
        if (this.store.projectWorkspace(id) !== workspaceId)
          throw new HttpError(403, 'Scope contains a project outside this workspace');
        this.store.project(id);
      }
    }
  }
  private membership(userId: string, workspaceId: string) {
    return this.store.db
      .prepare('SELECT * FROM auth_workspace_members WHERE user_id=? AND workspace_id=?')
      .get(userId, workspaceId) as MembershipRecord | undefined;
  }
  private localManagement(req: Request, userId?: string) {
    this.requireAdmin(req);
    if (
      this.workspaceId(req) !== LEGACY_WORKSPACE_ID ||
      this.principal(req).authMethod === 'preman'
    )
      throw new HttpError(403, 'Workspace membership is managed in PreMan');
    if (userId) {
      const member = this.membership(userId, this.workspaceId(req));
      if (!member) throw new HttpError(404, 'User not found');
      if (member.source !== 'local') throw new HttpError(403, 'This account is managed in PreMan');
    }
  }
  throttleSignIn(req: Request) {
    this.rateLimit(req);
  }
  private rateLimit(req: Request, email?: string) {
    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const keys = [`ip:${sha(ip)}`, ...(email ? [`account:${sha(email)}`] : [])];
    this.store.db.prepare('DELETE FROM auth_login_limits WHERE reset_at<=?').run(now);
    for (const key of keys) {
      const row = this.store.db
        .prepare('SELECT attempts FROM auth_login_limits WHERE key=?')
        .get(key) as { attempts: number } | undefined;
      if ((row?.attempts ?? 0) >= this.loginMaxAttempts)
        throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    }
    for (const key of keys)
      this.store.db
        .prepare(
          'INSERT INTO auth_login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1',
        )
        .run(key, now + this.loginWindowMs);
  }
  private setCookie(res: Response, value: string, maxAge: number) {
    res.cookie(cookieName, value, {
      httpOnly: true,
      secure: this.production,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  }
  private viewSession(req: Request) {
    return {
      principal: this.principal(req),
      csrfToken: this.sessions.get(req)?.csrfToken ?? null,
      expiresAt: this.sessions.get(req)?.expiresAt ?? null,
      ...(this.sessions.get(req)?.upstreamIdentity
        ? { upstreamIdentity: this.sessions.get(req)!.upstreamIdentity }
        : {}),
    };
  }
  startUserSession(
    req: Request,
    res: Response,
    userId: string,
    options: {
      workspaceId?: string;
      authMethod?: 'local' | 'oidc' | 'preman';
      expiresAt?: string;
      upstreamIdentity?: UpstreamIdentity;
    } = {},
  ) {
    const user = this.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId) as
      UserRecord | undefined;
    if (!user || user.disabled) throw new HttpError(401, 'Account is unavailable');
    const workspaceId = options.workspaceId ?? LEGACY_WORKSPACE_ID;
    const membership = this.membership(user.id, workspaceId);
    if (!membership || membership.disabled)
      throw new HttpError(401, 'Workspace access is unavailable');
    const maxTtl =
      options.authMethod === 'preman' ? Math.min(this.sessionTtlMs, 300_000) : this.sessionTtlMs;
    const now = Date.now();
    const deadline = Math.min(
      now + maxTtl,
      options.expiresAt ? Date.parse(options.expiresAt) : now + maxTtl,
    );
    const ttl = deadline - now;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new HttpError(401, 'Identity session has expired');
    const expiresAt = new Date(deadline).toISOString();
    const existingToken = options.authMethod === 'preman' ? sessionCookie(req) : undefined;
    if (existingToken) {
      const existing = this.store.db
        .prepare('SELECT * FROM auth_sessions WHERE token_hash=?')
        .get(sha(existingToken)) as SessionRecord | undefined;
      if (existing && !existing.revoked_at && live(existing.expires_at)) {
        const upstream = existing.upstream_identity_json
          ? (JSON.parse(existing.upstream_identity_json) as UpstreamIdentity)
          : undefined;
        const csrfToken = createHmac('sha256', existingToken)
          .update('mindtrust-csrf-v1')
          .digest('hex');
        const sameIdentity =
          existing.user_id === userId &&
          existing.workspace_id === workspaceId &&
          existing.auth_method === 'preman' &&
          upstream?.issuer === options.upstreamIdentity?.issuer &&
          upstream?.subject === options.upstreamIdentity?.subject &&
          upstream?.tenantId === options.upstreamIdentity?.tenantId;
        // Fresh upstream authorization extends only this browser's matching, CSRF-proven session.
        // Keeping its opaque token also preserves the renderer's existing CSRF token.
        if (sameIdentity && safeEqual(req.get('x-csrf-token') ?? '', csrfToken)) {
          this.authenticate(req);
          this.store.db
            .prepare('UPDATE auth_sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL')
            .run(expiresAt, existing.id);
          this.sessions.set(req, {
            id: existing.id,
            csrfToken,
            expiresAt,
            upstreamIdentity: options.upstreamIdentity,
          });
          this.setCookie(res, existingToken, Math.max(0, deadline - Date.now()));
          return this.viewSession(req);
        }
        // An explicit, one-use PKCE login may switch accounts/workspaces or start a
        // fresh browser context. The old cookie never authorizes the new identity.
        this.store.db
          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
          .run(at(), existing.id);
      }
    }
    const token = randomBytes(32).toString('hex'),
      id = randomUUID();
    this.store.db
      .prepare(
        'INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at,workspace_id,auth_method,upstream_identity_json) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        user.id,
        sha(token),
        expiresAt,
        at(),
        workspaceId,
        options.authMethod ?? 'local',
        options.upstreamIdentity ? JSON.stringify(options.upstreamIdentity) : null,
      );
    this.principals.set(req, {
      id: user.id,
      kind: 'user',
      role: membership.role,
      projectIds: JSON.parse(membership.projects_json),
      name: user.name,
      email: user.email,
      workspaceId,
      authMethod: options.authMethod ?? 'local',
    });
    const csrfToken = createHmac('sha256', token).update('mindtrust-csrf-v1').digest('hex');
    this.sessions.set(req, {
      id,
      csrfToken,
      expiresAt,
      upstreamIdentity: options.upstreamIdentity,
    });
    this.setCookie(res, token, Math.max(0, deadline - Date.now()));
    return this.viewSession(req);
  }
  mountPublicRoutes(app: Express) {
    app.get('/api/auth/status', (_req, res) =>
      res.json({
        enabled: this.enabled,
        production: this.production,
        ...(this.oidcDisplay ? { oidc: this.oidcDisplay } : {}),
        ...(this.premanDisplay ? { preman: this.premanDisplay } : {}),
      }),
    );
    app.post('/api/auth/login', async (req, res) => {
      const body = parse(
        z.object({
          email: z.string().trim().toLowerCase().email().max(254),
          password: z.string().min(1).max(256),
        }),
        req.body,
      );
      this.rateLimit(req, body.email);
      const user = this.store.db
        .prepare("SELECT * FROM auth_users WHERE email=? AND identity_source='local'")
        .get(body.email) as UserRecord | undefined;
      // The unknown-account path performs the same scrypt work and returns the same error.
      const encoded =
        user?.password_hash ??
        `scrypt$32768$8$1$00000000000000000000000000000000$${'0'.repeat(128)}`;
      if (!(await verifyPassword(body.password, encoded)) || !user || user.disabled)
        throw new HttpError(401, 'Email or password is incorrect');
      // Password verification yields to the event loop. A concurrent admin reset
      // must invalidate the old password before a fresh session is issued.
      const current = this.store.db
        .prepare('SELECT password_hash,disabled FROM auth_users WHERE id=?')
        .get(user.id) as { password_hash: string; disabled: number } | undefined;
      if (!current || current.disabled || current.password_hash !== encoded)
        throw new HttpError(401, 'Email or password is incorrect');
      res.json(this.startUserSession(req, res, user.id));
    });
  }
  mountRoutes(app: Express) {
    app.get('/api/auth/session', (req, res) => res.json(this.viewSession(req)));
    app.get('/api/auth/me', (req, res) => res.json(this.viewSession(req)));
    app.post('/api/auth/logout', (req, res) => {
      this.authenticate(req);
      const session = this.sessions.get(req);
      if (session)
        this.store.db
          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
          .run(at(), session.id);
      this.setCookie(res, '', 0);
      res.json({ ok: true });
    });
    app.post('/api/auth/change-password', async (req, res) => {
      const p = this.principal(req);
      if (p.kind !== 'user') throw new HttpError(403, 'Sign in as a user to change your password');
      if (p.authMethod === 'preman') throw new HttpError(403, 'This account is managed in PreMan');
      const body = parse(
        z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }),
        req.body,
      );
      this.rateLimit(req, p.email!);
      const user = this.store.db
        .prepare('SELECT * FROM auth_users WHERE id=?')
        .get(p.id) as unknown as UserRecord;
      if (!user.password_hash || !(await verifyPassword(body.currentPassword, user.password_hash)))
        throw new HttpError(401, 'Current password is incorrect');
      const passwordHash = await hashPassword(body.newPassword);
      this.store.transaction(() => {
        const current = this.store.db
          .prepare('SELECT password_hash,disabled FROM auth_users WHERE id=?')
          .get(p.id) as { password_hash: string; disabled: number } | undefined;
        const sessionId = this.sessions.get(req)?.id;
        const session = sessionId
          ? (this.store.db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(sessionId) as
              SessionRecord | undefined)
          : undefined;
        if (
          !current ||
          current.disabled ||
          current.password_hash !== user.password_hash ||
          !session ||
          session.revoked_at ||
          !live(session.expires_at)
        )
          throw new HttpError(
            409,
            'Account or session changed. Sign in again before changing your password.',
          );
        this.store.db
          .prepare('UPDATE auth_users SET password_hash=?,updated_at=? WHERE id=?')
          .run(passwordHash, at(), p.id);
        this.store.db
          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
          .run(at(), p.id);
      });
      this.setCookie(res, '', 0);
      res.json({ ok: true, signInRequired: true });
    });
    app.get('/api/users', (req, res) => {
      this.requireAdmin(req);
      res.json(
        (
          this.store.db
            .prepare(
              'SELECT u.*,m.role,m.projects_json,m.disabled FROM auth_users u JOIN auth_workspace_members m ON m.user_id=u.id WHERE m.workspace_id=? ORDER BY u.created_at DESC',
            )
            .all(this.workspaceId(req)) as unknown as UserRecord[]
        ).map(publicUser),
      );
    });
    app.post('/api/users', async (req, res) => {
      this.localManagement(req);
      const body = parse(
        z.object({
          email: z.string().trim().toLowerCase().email().max(254),
          name: nameSchema,
          password: passwordSchema,
          allowOidc: z.boolean().default(false),
          role: roles,
          projectIds: scopes,
        }),
        req.body,
      );
      this.validateScope(body.role, body.projectIds, this.workspaceId(req));
      if (
        this.store.db
          .prepare("SELECT id FROM auth_users WHERE email=? AND identity_source='local'")
          .get(body.email)
      )
        throw new HttpError(409, 'A user with this email already exists');
      const passwordHash = await hashPassword(body.password),
        id = randomUUID(),
        created = at();
      if (
        this.store.db
          .prepare("SELECT id FROM auth_users WHERE email=? AND identity_source='local'")
          .get(body.email)
      )
        throw new HttpError(409, 'A user with this email already exists');
      this.store.db
        .prepare(
          'INSERT INTO auth_users(id,email,name,password_hash,role,projects_json,created_at,updated_at,allow_oidc) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          body.email,
          body.name,
          passwordHash,
          body.role,
          JSON.stringify(body.projectIds),
          created,
          created,
          Number(body.allowOidc),
        );
      this.store.db
        .prepare(
          "INSERT INTO auth_workspace_members(user_id,workspace_id,role,projects_json,source) VALUES(?,?,?,?,'local')",
        )
        .run(id, this.workspaceId(req), body.role, JSON.stringify(body.projectIds));
      res
        .status(201)
        .json(
          publicUser(
            this.store.db
              .prepare('SELECT * FROM auth_users WHERE id=?')
              .get(id) as unknown as UserRecord,
          ),
        );
    });
    app.patch('/api/users/:id', async (req, res) => {
      this.localManagement(req, parse(idSchema, req.params.id));
      const id = parse(idSchema, req.params.id),
        body = parse(
          z.object({
            name: nameSchema.optional(),
            password: passwordSchema.optional(),
            role: roles.optional(),
            projectIds: scopes.optional(),
            disabled: z.boolean().optional(),
            allowOidc: z.boolean().optional(),
          }),
          req.body,
        );
      const user = this.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id) as
        UserRecord | undefined;
      if (!user) throw new HttpError(404, 'User not found');
      const role = body.role ?? user.role,
        projectIds =
          body.projectIds === undefined ? JSON.parse(user.projects_json) : body.projectIds;
      this.validateScope(role, projectIds, this.workspaceId(req));
      const passwordHash = body.password ? await hashPassword(body.password) : undefined;
      this.store.transaction(() => {
        // Preserve simultaneous permission changes while password hashing awaits.
        const current = this.store.db
          .prepare('SELECT * FROM auth_users WHERE id=?')
          .get(id) as unknown as UserRecord;
        const nextRole = body.role ?? current.role;
        const nextProjects =
          body.projectIds === undefined ? JSON.parse(current.projects_json) : body.projectIds;
        this.validateScope(nextRole, nextProjects, this.workspaceId(req));
        this.store.db
          .prepare(
            'UPDATE auth_users SET name=?,password_hash=?,role=?,projects_json=?,disabled=?,updated_at=?,allow_oidc=? WHERE id=?',
          )
          .run(
            body.name ?? current.name,
            passwordHash ?? current.password_hash,
            nextRole,
            JSON.stringify(nextProjects),
            body.disabled === undefined ? current.disabled : Number(body.disabled),
            at(),
            body.allowOidc === undefined ? current.allow_oidc : Number(body.allowOidc),
            id,
          );
        this.store.db
          .prepare(
            'UPDATE auth_workspace_members SET role=?,projects_json=?,disabled=? WHERE user_id=? AND workspace_id=?',
          )
          .run(
            nextRole,
            JSON.stringify(nextProjects),
            body.disabled === undefined ? current.disabled : Number(body.disabled),
            id,
            this.workspaceId(req),
          );
        if (body.password || body.disabled || body.allowOidc === false)
          this.store.db
            .prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
            .run(at(), id);
      });
      res.json(
        publicUser(
          this.store.db
            .prepare('SELECT * FROM auth_users WHERE id=?')
            .get(id) as unknown as UserRecord,
        ),
      );
    });
    app.post('/api/users/:id/revoke-sessions', (req, res) => {
      this.localManagement(req, parse(idSchema, req.params.id));
      const id = parse(idSchema, req.params.id);
      if (!this.store.db.prepare('SELECT id FROM auth_users WHERE id=?').get(id))
        throw new HttpError(404, 'User not found');
      this.store.db
        .prepare(
          'UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND workspace_id=? AND revoked_at IS NULL',
        )
        .run(at(), id, this.workspaceId(req));
      res.json({ ok: true });
    });
    app.get('/api/keys', (req, res) => {
      this.requireAdmin(req);
      res.json(
        (
          this.store.db
            .prepare('SELECT * FROM api_keys WHERE workspace_id=? ORDER BY created_at DESC')
            .all(this.workspaceId(req)) as unknown as KeyRecord[]
        ).map(publicKey),
      );
    });
    app.post('/api/keys', (req, res) => {
      this.requireAdmin(req);
      const body = parse(
        z.object({
          name: nameSchema,
          role: roles.optional(),
          projectIds: scopes.optional(),
          expiresAt: z.string().datetime({ offset: true }).optional(),
        }),
        req.body,
      );
      if (this.production && (body.role === undefined || body.projectIds === undefined))
        throw new HttpError(
          400,
          'Production keys require an explicit role and projectIds (null for all projects)',
        );
      const role = body.role ?? 'editor',
        projectIds = body.projectIds ?? null;
      this.validateScope(role, projectIds, this.workspaceId(req));
      const expiresAt = body.expiresAt
        ? new Date(body.expiresAt).toISOString()
        : new Date(Date.now() + 90 * 86400000).toISOString();
      if (
        Date.parse(expiresAt) <= Date.now() ||
        Date.parse(expiresAt) > Date.now() + 366 * 86400000
      )
        throw new HttpError(400, 'Key expiration must be in the future and within 366 days');
      const key = `mt_${randomBytes(32).toString('hex')}`,
        id = randomUUID();
      this.store.db
        .prepare(
          'INSERT INTO api_keys(id,name,prefix,hash,created_at,role,projects_json,expires_at,created_by,workspace_id,identity_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          body.name,
          key.slice(0, 11),
          sha(key),
          at(),
          role,
          JSON.stringify(projectIds),
          expiresAt,
          this.principal(req).id,
          this.workspaceId(req),
          this.principal(req).authMethod === 'preman' ? 'preman' : 'local',
        );
      res.status(201).json({
        ...publicKey(
          this.store.db
            .prepare('SELECT * FROM api_keys WHERE id=?')
            .get(id) as unknown as KeyRecord,
        ),
        key,
      });
    });
    app.delete('/api/keys/:id', (req, res) => {
      this.requireAdmin(req);
      const id = parse(idSchema, req.params.id);
      if (
        !this.store.db
          .prepare('SELECT id FROM api_keys WHERE id=? AND workspace_id=?')
          .get(id, this.workspaceId(req))
      )
        throw new HttpError(404, 'API key not found');
      this.store.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(at(), id);
      res.json({ ok: true });
    });
    app.get('/api/audit', (req, res) => {
      this.requireAdmin(req);
      const limit = positiveQuery(req.query.limit, 100, 500);
      const rows = this.store.db
        .prepare(
          'SELECT * FROM audit_events WHERE workspace_id=? ORDER BY at DESC,rowid DESC LIMIT ?',
        )
        .all(this.workspaceId(req), limit) as {
        id: string;
        at: string;
        actor_id: string | null;
        actor_kind: string;
        action: string;
        project_id: string | null;
        outcome: string;
        status_code: number;
      }[];
      res.json(
        rows.map((r) => ({
          id: r.id,
          at: r.at,
          actorId: r.actor_id,
          actorKind: r.actor_kind,
          action: r.action,
          projectId: r.project_id,
          outcome: r.outcome,
          statusCode: r.status_code,
        })),
      );
    });
  }
}
