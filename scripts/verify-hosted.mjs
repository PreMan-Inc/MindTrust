#!/usr/bin/env node
// Read-only acceptance checks. Credentials are sent only to the configured origin.
const timeoutMs = 15_000;
const localFlag = '--allow-loopback-http';

class CheckError extends Error {}
function requireCheck(condition, message) {
  if (!condition) throw new CheckError(message);
}

async function main() {
  requireCheck(
    process.argv.slice(2).every((arg) => arg === localFlag),
    `Usage: MINDTRUST_URL=https://verus.preman.live node scripts/verify-hosted.mjs [${localFlag}]`,
  );
  requireCheck(process.env.MINDTRUST_URL, 'Set MINDTRUST_URL to the HTTPS origin to verify.');
  requireCheck(
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    'Remove NODE_TLS_REJECT_UNAUTHORIZED=0; certificate verification must remain enabled.',
  );
  let base;
  try {
    base = new URL(process.env.MINDTRUST_URL);
  } catch {
    throw new CheckError('MINDTRUST_URL must be a valid HTTPS origin.');
  }
  requireCheck(
    !base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
    'MINDTRUST_URL must contain only the origin, without credentials, paths, query strings, or fragments.',
  );
  const local =
    process.argv.includes(localFlag) &&
    base.protocol === 'http:' &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  requireCheck(
    base.protocol === 'https:' || local,
    `HTTPS is required. ${localFlag} permits HTTP only for an explicit loopback integration check.`,
  );
  if (local) console.log('LOCAL ONLY: this run cannot verify public DNS or TLS.');

  async function get(path, label, { status = 200, authenticated = false } = {}) {
    const url = new URL(path, base);
    requireCheck(
      url.origin === base.origin,
      `${label}: asset URL must stay on the configured origin.`,
    );
    const headers = authenticated
      ? { Authorization: `Bearer ${process.env.MINDTRUST_API_KEY}` }
      : {};
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CheckError(
        `${label}: request failed or exceeded 15 seconds; check DNS, TLS, and service availability.`,
      );
    }
    requireCheck(
      response.status === status,
      `${label}: expected HTTP ${status}, received ${response.status}. Check routing, authentication, and deployment configuration.`,
    );
    return response;
  }

  async function read(response, label, json = false) {
    try {
      return json ? await response.json() : await response.text();
    } catch {
      throw new CheckError(
        `${label}: response body could not be read${json ? ' as JSON' : ''} within the request deadline.`,
      );
    }
  }

  function requireShell(response, html, label) {
    requireCheck(
      response.headers.get('content-type')?.includes('text/html') &&
        /<title>\s*Verus\b[^<]*<\/title>/i.test(html) &&
        /<div\s+id=["']root["']/i.test(html),
      `${label}: expected the built Verus HTML shell. Build and deploy the current web application.`,
    );
  }

  const root = await get('/', 'Root page');
  const html = await read(root, 'Root page');
  requireShell(root, html, 'Root page');
  console.log('PASS root page serves the Verus HTML shell');

  // These attributes cover the script and stylesheet/preload tags emitted by Vite.
  const assets = new Map();
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries(
      [...match[2].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map((a) => [
        a[1].toLowerCase(),
        a[3],
      ]),
    );
    const script = match[1].toLowerCase() === 'script';
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
    const kind =
      script || rel.includes('modulepreload')
        ? 'script'
        : rel.includes('stylesheet')
          ? 'style'
          : null;
    const reference = script ? attrs.src : attrs.href;
    if (kind && reference) {
      let url;
      try {
        url = new URL(reference, base);
      } catch {
        throw new CheckError('HTML assets: found an invalid asset URL.');
      }
      requireCheck(
        url.origin === base.origin && !url.username && !url.password,
        'HTML assets: scripts and styles must load from the configured origin.',
      );
      assets.set(url.href, kind);
    }
  }
  requireCheck(
    [...assets.values()].includes('script') && [...assets.values()].includes('style'),
    'HTML assets: expected compiled JavaScript and CSS references; run npm run build before deployment.',
  );
  for (const [url, kind] of assets) {
    const label = kind === 'script' ? 'JavaScript asset' : 'Stylesheet asset';
    const response = await get(url, label);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    requireCheck(
      kind === 'script'
        ? ['text/javascript', 'application/javascript', 'application/x-javascript'].includes(type)
        : type === 'text/css',
      `${label}: incorrect content type; check asset routing and the deployed build.`,
    );
    requireCheck((await read(response, label)).trim().length > 0, `${label}: response was empty.`);
  }
  console.log(`PASS ${assets.size} referenced JavaScript/CSS assets load from the same origin`);

  const deepPath = '/app/MindTrust/p/hosted-preflight/experiments/hosted-preflight';
  const deep = await get(deepPath, 'Deep link');
  requireShell(deep, await read(deep, 'Deep link'), 'Deep link');
  console.log('PASS experiment deep link serves the Verus HTML shell');

  const health = await read(await get('/api/health', 'Health'), 'Health', true);
  requireCheck(health?.status === 'ok', 'Health: expected status=ok; inspect service health.');
  console.log('PASS public health endpoint');

  const auth = await read(
    await get('/api/auth/status', 'Authentication status'),
    'Authentication status',
    true,
  );
  requireCheck(
    auth?.enabled === true && auth?.production === true,
    'Authentication status: production and enabled must both be true. Set production mode and a strong administrator token.',
  );
  console.log('PASS production authentication is enabled');
  const ancestors = root.headers
    .get('content-security-policy')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('frame-ancestors '));
  requireCheck(
    auth.preman
      ? ancestors === 'frame-ancestors https://app.preman.live' &&
          !root.headers.has('x-frame-options')
      : ancestors === "frame-ancestors 'none'" && root.headers.get('x-frame-options') === 'DENY',
    'Frame policy: expected exact PreMan app ancestry only when shared sign-in is configured, otherwise full frame denial.',
  );
  console.log('PASS conditional frame policy matches authentication configuration');

  await get('/api/projects', 'Anonymous projects request', { status: 401 });
  console.log('PASS anonymous project access is denied');

  if (process.env.MINDTRUST_API_KEY) {
    const projects = await read(
      await get('/api/projects', 'Authenticated projects request', { authenticated: true }),
      'Authenticated projects request',
      true,
    );
    requireCheck(
      Array.isArray(projects),
      'Authenticated projects request: expected a project list.',
    );
    console.log('PASS authenticated project list is readable');
  } else {
    console.log('SKIP authenticated project read: supply MINDTRUST_API_KEY to verify credentials.');
  }
  console.log(
    local
      ? 'Local production-mode checks passed; public deployment remains unverified.'
      : 'Hosted read-only checks passed; browser workflows and restart persistence need separate verification.',
  );
}

main().catch((error) => {
  // Never print response bodies, request headers, credentials, or raw network errors.
  console.error(
    `FAIL ${error instanceof CheckError ? error.message : 'Unexpected checker failure; inspect the script locally.'}`,
  );
  process.exitCode = 1;
});
