import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../deploy/verus-backup.sh', import.meta.url));
const runningId = `sha256:${'a'.repeat(64)}`;
const differentId = `sha256:${'b'.repeat(64)}`;
const containerId = 'fixture-running-container';
const releaseRef = '123456789012.dkr.ecr.us-east-1.amazonaws.com/verus:release-abc123';

// This executable never invokes Docker. Every accepted command returns only
// fixture data, and every unexpected command fails instead of reaching a daemon.
const dockerStub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const fail = process.env.FIXTURE_FAIL;
function out(value) { process.stdout.write(value + '\\n'); }
function refuse() { process.stderr.write('synthetic docker inspection failed\\n'); process.exit(19); }
if (args[0] === 'inspect' && args[1] === '--format' && args[3] === process.env.FIXTURE_CONTAINER) {
  if (args[2] === '{{.Image}}') {
    if (fail === 'running-id') refuse();
    out(process.env.FIXTURE_RUNNING_ID);
  } else if (args[2] === '{{.Config.Image}}') {
    if (fail === 'configured-ref') refuse();
    out(process.env.FIXTURE_REFERENCE);
  } else refuse();
} else if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format' && args[3] === '{{.Id}}') {
  // The running config digest is deliberately unavailable as a local lookup;
  // only the original preserved reference can identify the local image.
  if (fail === 'local-image' || args[4] !== process.env.FIXTURE_REFERENCE || args[4] === process.env.FIXTURE_RUNNING_ID) refuse();
  out(process.env.FIXTURE_LOCAL_ID);
} else refuse();
`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'verus-release-image-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), dockerStub, { mode: 0o700 });
  const log = join(directory, 'docker-calls.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function run(
    options: {
      reference?: string;
      imageId?: string;
      localId?: string;
      failure?: string;
      sourceOnly?: boolean;
    } = {},
  ) {
    await writeFile(log, '');
    const command = options.sourceOnly
      ? 'source "$1"; declare -F verus_running_image >/dev/null'
      : 'source "$1"; verus_running_image "$2"';
    let status = 0,
      stdout = '',
      stderr = '';
    try {
      const result = await exec(
        'bash',
        ['-c', command, 'verus-image-fixture', script, containerId],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            FIXTURE_DOCKER_LOG: log,
            FIXTURE_CONTAINER: containerId,
            FIXTURE_RUNNING_ID: options.imageId ?? runningId,
            FIXTURE_REFERENCE: options.reference ?? releaseRef,
            FIXTURE_LOCAL_ID: options.localId ?? runningId,
            FIXTURE_FAIL: options.failure ?? '',
          },
          timeout: 5000,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      status = typeof failure.code === 'number' ? failure.code : -1;
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert(
      calls.every(
        (args) => args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect'),
      ),
      'image selection must never run, pull, list, or replace an image',
    );
    return { status, stdout, stderr, calls };
  }
  return { run };
}

test('backup functions can be sourced without privilege checks, filesystem backup work, or Docker calls', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ sourceOnly: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.calls, []);
});

for (const [label, reference] of [
  ['immutable release tag', releaseRef],
  ['legacy implicit latest tag', 'verus-mindtrust'],
  ['legacy latest tag', 'ghcr.io/preman-inc/verus:latest'],
  ['registry digest reference', `registry.example.test/verus@sha256:${'c'.repeat(64)}`],
] as const) {
  test(`selects only the checked original ${label} matching the running config ID`, async (t) => {
    const f = await fixture(t);
    const result = await f.run({ reference });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${reference}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.calls, [
      ['inspect', '--format', '{{.Image}}', containerId],
      ['inspect', '--format', '{{.Config.Image}}', containerId],
      ['image', 'inspect', '--format', '{{.Id}}', reference],
    ]);
  });
}

test('an unavailable bare config digest does not prevent use of its verified preserved release tag', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${releaseRef}\n`);
  assert(!result.calls.some((args) => args[0] === 'image' && args.includes(runningId)));
});

test('a missing local release tag refuses backup without falling back to latest, a digest, or a pull', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ failure: 'local-image' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unavailable locally/i);
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls[2].at(-1), releaseRef);
});

test('a moved release tag refuses to run a helper from an image different from the running release', async (t) => {
  const f = await fixture(t);
  const result = await f.run({ localId: differentId });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /another image|refusing/i);
  assert.equal(result.calls.length, 3);
});

for (const imageId of [
  '',
  'sha256:short',
  'sha256:' + 'g'.repeat(64),
  'sha256:' + 'a'.repeat(65),
  'sha256:' + 'A'.repeat(64),
  `${runningId}\nextra`,
]) {
  test(`rejects malformed running image ID ${JSON.stringify(imageId)} before local lookup`, async (t) => {
    const f = await fixture(t);
    const result = await f.run({ imageId });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert(!result.calls.some((args) => args[0] === 'image'));
  });
}

for (const [label, reference] of [
  ['empty', ''],
  ['option injection', '--pull=always'],
  ['spaces', 'registry.example.test/verus:tag extra'],
  ['shell punctuation', 'verus:tag;echo-injected'],
  ['command substitution', 'verus:$(echo-injected)'],
  ['newline', 'verus:tag\nother'],
  ['overlong', 'v'.repeat(2049)],
] as const) {
  test(`rejects ${label} reference before Docker can interpret it`, async (t) => {
    const f = await fixture(t);
    const result = await f.run({ reference });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert(!result.calls.some((args) => args[0] === 'image'));
  });
}

for (const failure of ['running-id', 'configured-ref', 'local-image']) {
  test(`Docker ${failure} inspection failure returns no runnable reference and has no fallback`, async (t) => {
    const f = await fixture(t);
    const result = await f.run({ failure });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(
      result.calls.length,
      failure === 'running-id' ? 1 : failure === 'configured-ref' ? 2 : 3,
    );
  });
}
