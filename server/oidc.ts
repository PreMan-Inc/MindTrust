import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AccessController } from './auth.ts';
import { HttpError, type Store } from './store.ts';

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  label?: string;
  /** Local integration-test issuers only. Never enabled by production environment config. */
  allowInsecureLocalhost?: boolean;
}
interface Flow {
  state_hash: string;
  cookie_hash: string;
  verifier: string;
  nonce: string;
  expires_at: number;
}
interface OidcUser {
  id: string;
  disabled: number;
  allow_oidc: number;
  oidc_issuer: string | null;
  oidc_subject: string | null;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const flowCookie = 'mindtrust_oidc_flow';
const callbackPath = '/api/auth/oidc/callback';
function isLoopback(url: URL) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}
function readFlowCookie(req: Request) {
  const parts = (req.get('cookie') ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${flowCookie}=`));
  if (parts.length !== 1) return undefined;
  const value = parts[0].slice(flowCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** Optional OIDC authorization-code flow; no automatic public account creation. */
export function mountOidc(
  app: Express,
  store: Store,
  access: AccessController,
  options: OidcOptions,
  allowedOrigins: string[],
) {
  let issuer: URL, redirect: URL;
  try {
    issuer = new URL(options.issuer);
    redirect = new URL(options.redirectUri);
  } catch {
    throw new Error('OIDC issuer and redirect URI must be valid URLs');
  }
  const insecure =
    !!options.allowInsecureLocalhost &&
    !access.production &&
    isLoopback(issuer) &&
    isLoopback(redirect);
  if ((issuer.protocol !== 'https:' || redirect.protocol !== 'https:') && !insecure)
    throw new Error('OIDC requires HTTPS issuer and redirect URI');
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !== callbackPath
  )
    throw new Error(
      'OIDC URLs must not contain credentials, queries, or fragments; redirect must use /api/auth/oidc/callback',
    );
  if (!insecure && !allowedOrigins.includes(redirect.origin))
    throw new Error('OIDC redirect origin must be an allowed application origin');
  if (
    !options.clientId ||
    options.clientId.length > 1000 ||
    !options.clientSecret ||
    options.clientSecret.length > 4096
  )
    throw new Error('OIDC client ID and secret are required');
  if (access.production && options.allowInsecureLocalhost)
    throw new Error('Insecure OIDC is forbidden in production');
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS auth_oidc_flows(state_hash TEXT PRIMARY KEY,cookie_hash TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL)',
  );
  access.configureOidc(options.label ?? 'Organization SSO');
  let configuration: Promise<oidc.Configuration> | undefined;
  const config = () => {
    if (!configuration)
      configuration = oidc
        .discovery(issuer, options.clientId, options.clientSecret, undefined, {
          timeout: 10,
          execute: [
            ...(insecure ? [oidc.allowInsecureRequests] : []),
            oidc.enableNonRepudiationChecks,
          ],
        })
        .then((c) => {
          const metadata = c.serverMetadata();
          if (metadata.issuer !== options.issuer) throw new Error('OIDC issuer mismatch');
          for (const endpoint of [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.jwks_uri,
          ]) {
            if (typeof endpoint !== 'string')
              throw new Error('OIDC discovery is missing a required endpoint');
            const url = new URL(endpoint);
            if (
              url.protocol !== 'https:' &&
              !(insecure && url.protocol === 'http:' && isLoopback(url))
            )
              throw new Error('OIDC discovery returned an unsafe endpoint');
          }
          return c;
        })
        .catch((error) => {
          configuration = undefined;
          throw error;
        });
    return configuration;
  };
  const consume = (state: string, cookie: string): Flow | undefined =>
    store.db
      .prepare(
        'DELETE FROM auth_oidc_flows WHERE state_hash=? AND cookie_hash=? AND expires_at>? RETURNING *',
      )
      .get(digest(state), digest(cookie), Date.now()) as unknown as Flow | undefined;
  app.get('/api/auth/oidc/login', async (req, res) => {
    try {
      access.throttleSignIn(req);
      store.db.prepare('DELETE FROM auth_oidc_flows WHERE expires_at<=?').run(Date.now());
      if (
        Number(
          (
            store.db.prepare('SELECT COUNT(*) AS count FROM auth_oidc_flows').get() as {
              count: number;
            }
          ).count,
        ) >= 1000
      )
        throw new HttpError(503, 'Too many pending sign-ins');
      const c = await config(),
        state = oidc.randomState(),
        nonce = oidc.randomNonce(),
        verifier = oidc.randomPKCECodeVerifier(),
        cookie = randomBytes(32).toString('hex');
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      store.db
        .prepare(
          'INSERT INTO auth_oidc_flows(state_hash,cookie_hash,verifier,nonce,expires_at) VALUES(?,?,?,?,?)',
        )
        .run(digest(state), digest(cookie), verifier, nonce, Date.now() + 5 * 60 * 1000);
      res.cookie(flowCookie, cookie, {
        httpOnly: true,
        secure: access.production,
        sameSite: 'lax',
        path: '/api/auth/oidc',
        maxAge: 5 * 60 * 1000,
      });
      res.redirect(
        302,
        oidc.buildAuthorizationUrl(c, {
          redirect_uri: options.redirectUri,
          scope: 'openid email profile',
          response_type: 'code',
          response_mode: 'query',
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).href,
      );
    } catch {
      access.audit(req, 'auth.oidc.start', 503);
      res.redirect(302, '/?auth_error=oidc');
    }
  });
  app.get(callbackPath, async (req, res) => {
    try {
      // Never infer callback origin from Host/X-Forwarded-Host or accept a returnTo parameter.
      const current = new URL(options.redirectUri);
      current.search = new URL(req.originalUrl, 'http://callback.invalid').search;
      const states = current.searchParams.getAll('state'),
        cookie = readFlowCookie(req);
      if (states.length !== 1 || states[0].length > 256 || !cookie)
        throw new Error('Invalid OIDC callback');
      const flow = consume(states[0], cookie);
      if (!flow) throw new Error('OIDC state is expired, replayed, or belongs to another browser');
      res.clearCookie(flowCookie, {
        httpOnly: true,
        secure: access.production,
        sameSite: 'lax',
        path: '/api/auth/oidc',
      });
      const tokens = await oidc.authorizationCodeGrant(await config(), current, {
        pkceCodeVerifier: flow.verifier,
        expectedNonce: flow.nonce,
        expectedState: states[0],
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== options.issuer || typeof claims.sub !== 'string' || !claims.sub)
        throw new Error('Invalid verified OIDC identity');
      // Binding is to issuer+subject. Email is considered once, only when the admin
      // explicitly enabled SSO on a preprovisioned account, and only if verified.
      let user = store.db
        .prepare('SELECT * FROM auth_users WHERE oidc_issuer=? AND oidc_subject=?')
        .get(options.issuer, claims.sub) as unknown as OidcUser | undefined;
      if (!user) {
        if (claims.email_verified !== true || typeof claims.email !== 'string')
          throw new Error('A verified preprovisioned email is required');
        const email = z.string().trim().toLowerCase().email().max(254).parse(claims.email);
        user = store.db
          .prepare("SELECT * FROM auth_users WHERE email=? AND identity_source='local'")
          .get(email) as unknown as OidcUser | undefined;
        if (!user || user.disabled || !user.allow_oidc || user.oidc_issuer || user.oidc_subject)
          throw new Error('This identity is not provisioned for SSO');
        const bound = store.db
          .prepare(
            'UPDATE auth_users SET oidc_issuer=?,oidc_subject=?,updated_at=? WHERE id=? AND oidc_issuer IS NULL AND oidc_subject IS NULL AND allow_oidc=1 AND disabled=0',
          )
          .run(options.issuer, claims.sub, new Date().toISOString(), user.id);
        if (bound.changes !== 1) throw new Error('SSO binding changed during authentication');
      }
      if (user.disabled || !user.allow_oidc) throw new Error('SSO is disabled for this account');
      access.startUserSession(req, res, user.id, { authMethod: 'oidc' });
      access.audit(req, 'auth.oidc.login', 200);
      res.redirect(302, '/');
    } catch {
      access.audit(req, 'auth.oidc.login', 401);
      res.redirect(302, '/?auth_error=oidc');
    }
  });
}
