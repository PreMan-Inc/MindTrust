import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createApp } from '../server/app.ts';
const admin = 'oidc-test-bootstrap-secret-with-32-characters';

async function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fixture-key',
    use: 'sig',
    alg: 'RS256',
  };
  let issuer = '',
    subject = 'subject-1',
    email = 'teammate@example.test',
    verified = true,
    badNonce = false,
    badAudience = false,
    badSignature = false;
  let tokenCalls = 0,
    pkceChecks = 0;
  const codes = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      redirect: string;
      subject: string;
      email: string;
      verified: boolean;
      badNonce: boolean;
      badAudience: boolean;
      badSignature: boolean;
    }
  >();
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (data: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert(url.searchParams.get('nonce'));
      assert(url.searchParams.get('state'));
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        redirect: url.searchParams.get('redirect_uri')!,
        subject,
        email,
        verified,
        badNonce,
        badAudience,
        badSignature,
      });
      const target = new URL(url.searchParams.get('redirect_uri')!);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state')!);
      target.searchParams.set('iss', issuer);
      res.writeHead(302, { location: target.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      tokenCalls++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString()),
        code = body.get('code')!,
        flow = codes.get(code);
      codes.delete(code);
      if (!flow) return json({ error: 'invalid_grant' }, 400);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), flow.redirect);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
        : null;
      assert.equal(body.get('client_secret') ?? basic?.[1], 'fixture-client-secret');
      assert.equal(body.get('client_id') ?? basic?.[0], 'mindtrust-fixture');
      if (
        createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url') !== flow.challenge
      )
        return json({ error: 'invalid_grant' }, 400);
      pkceChecks++;
      const now = Math.floor(Date.now() / 1000),
        header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString(
          'base64url',
        ),
        payload = Buffer.from(
          JSON.stringify({
            iss: issuer,
            aud: flow.badAudience ? 'wrong-client' : 'mindtrust-fixture',
            sub: flow.subject,
            iat: now,
            exp: now + 300,
            nonce: flow.badNonce ? 'wrong-nonce' : flow.nonce,
            email: flow.email,
            email_verified: flow.verified,
          }),
        ).toString('base64url'),
        message = `${header}.${payload}`,
        signature = sign(
          'RSA-SHA256',
          Buffer.from(message),
          flow.badSignature ? other.privateKey : privateKey,
        ).toString('base64url');
      return json({
        token_type: 'Bearer',
        access_token: 'provider-access-token-must-not-be-stored',
        expires_in: 300,
        id_token: `${message}.${signature}`,
      });
    }
    json({ error: 'not_found' }, 404);
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const pa = provider.address();
  assert(pa && typeof pa !== 'string');
  issuer = `http://127.0.0.1:${pa.port}`;
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const app = createApp({
    dbPath: ':memory:',
    seed: false,
    production: false,
    adminToken: admin,
    loginMaxAttempts: 100,
    oidc: {
      issuer,
      clientId: 'mindtrust-fixture',
      clientSecret: 'fixture-client-secret',
      redirectUri: `${base}/api/auth/oidc/callback`,
      label: 'Test organization',
      allowInsecureLocalhost: true,
    },
  });
  server.on('request', app.app);
  async function api(path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function provision(address = 'teammate@example.test', allowOidc = true) {
    const user = await api('/api/users', {
      email: address,
      name: 'SSO teammate',
      password: 'initial secret passphrase',
      role: 'viewer',
      projectIds: [],
      allowOidc,
    });
    assert.equal(user.status, 201);
    return user.data;
  }
  async function begin() {
    const start = await fetch(`${base}/api/auth/oidc/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    assert(!start.headers.get('location')?.includes('auth_error'));
    const flowCookie = start.headers.get('set-cookie')!.split(';')[0];
    const authorization = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    return { flowCookie, callback: authorization.headers.get('location')! };
  }
  async function finish(
    flow: Awaited<ReturnType<typeof begin>>,
    override?: { cookie?: string; callback?: string },
  ) {
    return fetch(override?.callback ?? flow.callback, {
      headers: { cookie: override?.cookie ?? flow.flowCookie },
      redirect: 'manual',
    });
  }
  return {
    ...app,
    api,
    provision,
    begin,
    finish,
    base,
    setClaims: (
      value: Partial<{
        subject: string;
        email: string;
        verified: boolean;
        badNonce: boolean;
        badAudience: boolean;
        badSignature: boolean;
      }>,
    ) => {
      subject = value.subject ?? subject;
      email = value.email ?? email;
      verified = value.verified ?? verified;
      badNonce = value.badNonce ?? badNonce;
      badAudience = value.badAudience ?? badAudience;
      badSignature = value.badSignature ?? badSignature;
    },
    stats: () => ({ tokenCalls, pkceChecks }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    },
  };
}

test('OIDC uses real discovery, signed ID tokens, PKCE and immutable preprovisioned identity binding', async () => {
  const f = await fixture();
  try {
    const user = await f.provision();
    const status = (await f.api('/api/auth/status')).data;
    assert.deepEqual(status.oidc, { label: 'Test organization', loginUrl: '/api/auth/oidc/login' });
    const flow = await f.begin();
    const storedFlow = f.store.db.prepare('SELECT * FROM auth_oidc_flows').get()!;
    assert(!JSON.stringify(storedFlow).includes(new URL(flow.callback).searchParams.get('state')!));
    assert(!JSON.stringify(storedFlow).includes(flow.flowCookie.split('=')[1]));
    const response = await f.finish(flow);
    assert.equal(response.headers.get('location'), '/');
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    const cookies = response.headers.getSetCookie(),
      session = cookies.find((c) => c.startsWith('mindtrust_session='))!.split(';')[0];
    const me = await fetch(`${f.base}/api/auth/session`, { headers: { cookie: session } });
    assert.equal((await me.json()).principal.id, user.id);
    const after = (await f.api('/api/users')).data.find((u: any) => u.id === user.id);
    assert.equal(after.oidcLinked, true);
    assert.equal(f.stats().pkceChecks, 1);
    assert.equal((await f.finish(flow)).headers.get('location'), '/?auth_error=oidc');
    assert.equal(f.stats().tokenCalls, 1, 'A replay must not exchange another token');
    f.setClaims({ email: 'changed-address@example.test' });
    assert.equal((await f.finish(await f.begin())).headers.get('location'), '/');
    assert.equal(
      (await f.api('/api/users')).data.find((u: any) => u.id === user.id).email,
      'teammate@example.test',
    );
    f.setClaims({ email: 'teammate@example.test', subject: 'different-subject' });
    assert.equal((await f.finish(await f.begin())).headers.get('location'), '/?auth_error=oidc');
    const identities = f.store.db
      .prepare('SELECT oidc_subject FROM auth_users WHERE id=?')
      .get(user.id)!;
    assert.equal(identities.oidc_subject, 'subject-1');
    const serialized =
      JSON.stringify(f.store.db.prepare('SELECT * FROM auth_sessions').all()) +
      JSON.stringify(f.store.db.prepare('SELECT * FROM audit_events').all());
    assert(!serialized.includes('provider-access-token'));
    assert(!serialized.includes('fixture-client-secret'));
  } finally {
    await f.close();
  }
});

test('OIDC refuses unprovisioned, unverified, disabled, wrong nonce, audience and signature identities', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.finish(await f.begin())).headers.get('location'), '/?auth_error=oidc');
    const user = await f.provision('teammate@example.test', false);
    assert.equal((await f.finish(await f.begin())).headers.get('location'), '/?auth_error=oidc');
    f.store.db.prepare('UPDATE auth_users SET allow_oidc=1 WHERE id=?').run(user.id);
    for (const bad of [
      { verified: false },
      { verified: true, badNonce: true },
      { badNonce: false, badAudience: true },
      { badAudience: false, badSignature: true },
    ]) {
      f.setClaims(bad);
      assert.equal((await f.finish(await f.begin())).headers.get('location'), '/?auth_error=oidc');
      assert.equal(
        f.store.db.prepare('SELECT oidc_subject FROM auth_users WHERE id=?').get(user.id)!
          .oidc_subject,
        null,
      );
    }
    f.setClaims({ badSignature: false });
    f.store.db.prepare('UPDATE auth_users SET disabled=1 WHERE id=?').run(user.id);
    assert.equal((await f.finish(await f.begin())).headers.get('location'), '/?auth_error=oidc');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()!.count, 0);
  } finally {
    await f.close();
  }
});

test('OIDC state is browser-bound, expires, and rejects tampered callbacks without token exchange', async () => {
  const f = await fixture();
  try {
    await f.provision();
    const flow = await f.begin();
    assert.equal(
      (await f.finish(flow, { cookie: `mindtrust_oidc_flow=${'1'.repeat(64)}` })).headers.get(
        'location',
      ),
      '/?auth_error=oidc',
    );
    const tampered = new URL(flow.callback);
    tampered.searchParams.set('state', 'tampered');
    assert.equal(
      (await f.finish(flow, { callback: tampered.href })).headers.get('location'),
      '/?auth_error=oidc',
    );
    assert.equal(f.stats().tokenCalls, 0);
    f.store.db.prepare('UPDATE auth_oidc_flows SET expires_at=?').run(Date.now() - 1);
    assert.equal((await f.finish(flow)).headers.get('location'), '/?auth_error=oidc');
    assert.equal(f.stats().tokenCalls, 0);
  } finally {
    await f.close();
  }
});
