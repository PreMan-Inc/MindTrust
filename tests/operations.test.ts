import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createBackup, restoreBackup, verifyBackup } from '../server/backup.ts';
import { acquireProcessLock, canonicalDatabasePath } from '../server/process-lock.ts';
import { Store } from '../server/store.ts';
import { writeTrace } from '../server/traces.ts';
import { EvaluationQueue } from '../server/evaluation.ts';
import { createApp } from '../server/app.ts';

const project = {
  id: 'p',
  name: 'Synthetic verification',
  description: '',
  createdAt: '2026-10-10T00:00:00.000Z',
};

test('live backup is consistent, verifies contents, restores historical versions, and refuses overwrite/corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindtrust-backup-'));
  const source = join(dir, 'source.sqlite'),
    destination = join(dir, 'backup.sqlite');
  const store = new Store(source);
  try {
    store.put('project', project, project.id);
    const d = {
      id: 'd',
      projectId: 'p',
      name: 'Cases',
      description: '',
      version: 1,
      rowCount: 1,
      updatedAt: project.createdAt,
    };
    store.transaction(() =>
      store.saveDatasetSnapshot(d, [
        { id: 'r', input: 'old', expected: 'ok', metadata: {}, tags: [] },
      ]),
    );
    const manifest = await createBackup(source, destination);
    assert.equal(manifest.recordCounts.project, 1);
    store.transaction(() =>
      store.saveDatasetSnapshot({ ...d, version: 2 }, [
        { id: 'r', input: 'new', expected: 'ok', metadata: {}, tags: [] },
      ]),
    );
    assert.deepEqual(await verifyBackup(destination), manifest);
    const restored = join(dir, 'restored.sqlite');
    await restoreBackup(destination, restored);
    const copy = new Store(restored);
    try {
      assert.equal(copy.datasetRows('d')[0].input, 'old');
      assert.equal(copy.datasetVersions('d').length, 1);
    } finally {
      copy.close();
    }
    await assert.rejects(restoreBackup(destination, restored));
    await assert.rejects(createBackup(source, destination), /already exists/);
    const bytes = await readFile(destination);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(destination, bytes);
    await assert.rejects(verifyBackup(destination), /checksum/);
    await assert.rejects(restoreBackup(destination, join(dir, 'bad.sqlite')), /checksum/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exclusive workspace lock rejects another writer and automatically releases after a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindtrust-lock-'));
  const path = join(dir, 'db.lock');
  try {
    const release = acquireProcessLock(path);
    assert.throws(() => acquireProcessLock(path), /owns this database/);
    release();
    release();
    acquireProcessLock(path)();
    const script =
      "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=0;PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE;');console.log('locked');setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await once(child.stdout!, 'data');
      assert.throws(() => acquireProcessLock(path));
      child.kill('SIGKILL');
      await once(child, 'exit');
      acquireProcessLock(path)();
    } finally {
      child.kill('SIGKILL');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQL pagination and overview preserve status/search/unknown cost semantics and project isolation', () => {
  const store = new Store(':memory:');
  try {
    store.put('project', project, 'p');
    store.put('project', { ...project, id: 'other' }, 'other');
    for (let i = 0; i < 12; i++)
      writeTrace(store, i === 11 ? 'other' : 'p', {
        id: `t-${i}`,
        name: `Case ${i}`,
        input: { needle: i % 2 === 0 ? 'Special' : 'normal' },
        status: i % 3 === 0 ? 'error' : 'ok',
        startTime: `2026-10-10T00:00:${String(i).padStart(2, '0')}.000Z`,
        endTime: `2026-10-10T00:00:${String(i).padStart(2, '0')}.100Z`,
        costUsd: i === 0 ? null : 0.1,
        inputTokens: 10,
        outputTokens: 5,
      });
    const page = store.queryTraces('p', { limit: 3, offset: 2 });
    assert.equal(page.total, 11);
    assert.equal(page.items.length, 3);
    assert.equal(page.items[0].id, 't-8');
    assert.equal(
      store.queryTraces('p', { search: 'special', status: 'error', limit: 200, offset: 0 }).total,
      2,
    );
    const overview = store.overview('p');
    assert.equal(overview.traceCount, 11);
    assert.equal(overview.errorCount, 4);
    assert.equal(overview.unknownCostCount, 1);
    assert.equal(overview.totalTokens, 165);
    assert.equal(overview.p50LatencyMs, 100);
    assert.equal(overview.recentTraces.length, 8);
    assert.equal(overview.series[0].traces, 11);
  } finally {
    store.close();
  }
});

test('evaluation scheduling bounds in-memory active runs and stops without losing queued records', async () => {
  const store = new Store(':memory:');
  const queue = new EvaluationQueue(store, { baseUrl: 'http://localhost' });
  try {
    // Dispatch happens on a later turn. Test the scheduler admission boundary
    // before workers can load a dataset snapshot or call a provider.
    for (let i = 0; i < 20; i++) queue.enqueue(`pending-${i}`);
    assert.equal(queue.stats().activeJobs, 4);
    assert.equal(queue.stats().queuedJobs, 16);
    for (let i = 20; i < 1004; i++) queue.enqueue(`pending-${i}`);
    assert.throws(() => queue.assertCapacity(), /queue is full/);
    await queue.close();
    assert.equal(queue.stats().stopping, true);
    assert.throws(() => queue.assertCapacity(), /draining/);
  } finally {
    await queue.close();
    store.close();
  }
});

test('health probes, restricted metrics, request IDs and graceful draining expose no trace content', async () => {
  const instance = createApp({ dbPath: ':memory:', seed: false, adminToken: 'a'.repeat(40) });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/readyz')).status, 200);
    assert.equal((await fetch(base + '/metrics')).status, 401);
    const ok = await fetch(base + '/api/projects?secret=never-log-this', {
      headers: { authorization: 'Bearer ' + 'a'.repeat(40) },
    });
    assert(ok.headers.get('x-request-id'));
    const metric = await fetch(base + '/metrics', {
      headers: { authorization: 'Bearer ' + 'a'.repeat(40) },
    });
    assert.equal(metric.status, 200);
    const text = await metric.text();
    assert(text.includes('mindtrust_http_requests_total'));
    assert(!text.includes('never-log-this'));
    assert(!text.includes('Bearer'));
    instance.operations.drain();
    assert.equal((await fetch(base + '/readyz')).status, 503);
    assert.equal((await fetch(base + '/livez')).status, 200);
    for (const path of ['/readyz', '/livez', '/api/health'])
      assert.equal(
        (
          await fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        503,
      );
    const denied = await fetch(base + '/api/projects', {
      headers: { authorization: 'Bearer ' + 'a'.repeat(40) },
    });
    assert.equal(denied.status, 503);
    assert.equal(denied.headers.get('retry-after'), '5');
  } finally {
    await instance.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('separate customer workspaces reject each others credentials even with identical project identifiers', async () => {
  const workspaceA = createApp({ dbPath: ':memory:', seed: false, adminToken: 'a'.repeat(40) });
  const workspaceB = createApp({ dbPath: ':memory:', seed: false, adminToken: 'b'.repeat(40) });
  const first = workspaceA.app.listen(0, '127.0.0.1'),
    second = workspaceB.app.listen(0, '127.0.0.1');
  await Promise.all([once(first, 'listening'), once(second, 'listening')]);
  const a = first.address(),
    b = second.address();
  assert(a && b && typeof a !== 'string' && typeof b !== 'string');
  workspaceA.store.put('project', { ...project, name: 'Only customer A' }, 'p');
  workspaceB.store.put('project', { ...project, name: 'Only customer B' }, 'p');
  try {
    for (const [port, token, expected] of [
      [a.port, 'a', 'Only customer A'],
      [b.port, 'b', 'Only customer B'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { authorization: `Bearer ${token.repeat(40)}` },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json())[0].name, expected);
    }
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${a.port}/api/projects`, {
          headers: { authorization: 'Bearer ' + 'b'.repeat(40) },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${b.port}/api/projects`, {
          headers: { authorization: 'Bearer ' + 'a'.repeat(40) },
        })
      ).status,
      401,
    );
  } finally {
    await Promise.all([workspaceA.close(), workspaceB.close()]);
    await Promise.all([
      new Promise<void>((done) => first.close(() => done())),
      new Promise<void>((done) => second.close(() => done())),
    ]);
  }
});

test('backup artifacts are standalone and stale SQLite sidecars cannot influence verification or restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindtrust-sidecars-'));
  const source = join(dir, 'source.sqlite'),
    saved = join(dir, 'backup.sqlite'),
    target = join(dir, 'restored.sqlite');
  const store = new Store(source);
  try {
    store.put('project', project, 'p');
    await createBackup(source, saved);
    const db = new DatabaseSync(saved, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    } finally {
      db.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await writeFile(saved + suffix, 'untrusted sidecar');
      await assert.rejects(verifyBackup(saved), /sidecars/);
      await rm(saved + suffix);
      await writeFile(target + suffix, 'stale sidecar');
      await assert.rejects(restoreBackup(saved, target), /sidecars/);
      await assert.rejects(readFile(target), { code: 'ENOENT' });
      assert.equal(await readFile(target + suffix, 'utf8'), 'stale sidecar');
      await rm(target + suffix);
    }
    const release = acquireProcessLock(target + '.lock');
    try {
      await assert.rejects(restoreBackup(saved, target), /owns this database/);
    } finally {
      release();
    }
    await restoreBackup(saved, target);
    assert.equal((await readFile(target)).equals(await readFile(saved)), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('canonical database paths cannot obtain independent writer locks through symlinks or hard links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindtrust-alias-'));
  const path = join(dir, 'main.sqlite'),
    alias = join(dir, 'alias.sqlite'),
    hard = join(dir, 'hard.sqlite');
  const store = new Store(path);
  store.close();
  try {
    await symlink(path, alias);
    assert.equal(canonicalDatabasePath(alias), canonicalDatabasePath(path));
    const release = acquireProcessLock(canonicalDatabasePath(path) + '.lock');
    try {
      assert.throws(
        () => acquireProcessLock(canonicalDatabasePath(alias) + '.lock'),
        /owns this database/,
      );
    } finally {
      release();
    }
    await link(path, hard);
    assert.throws(() => canonicalDatabasePath(hard), /hard-link/);
    assert.throws(() => canonicalDatabasePath(path), /hard-link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
