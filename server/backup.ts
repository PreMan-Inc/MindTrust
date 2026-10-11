import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { acquireProcessLock, canonicalDatabasePath } from './process-lock.ts';

export interface BackupManifest {
  format: 'mindtrust-sqlite-backup-v1';
  createdAt: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
  recordCounts: Record<string, number>;
}
const sidecars = ['-wal', '-shm', '-journal'] as const;
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function requireAbsent(paths: string[], message: string) {
  for (const path of paths) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(message);
  }
}
async function requireStandalone(path: string) {
  if (!(await lstat(path)).isFile())
    throw new Error('Backup artifact must be a regular file, not a symbolic link');
  await requireAbsent(
    sidecars.map((suffix) => path + suffix),
    'Backup artifact has unexpected SQLite sidecars',
  );
}
function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
      throw new Error('Backup database integrity check failed');
    const schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (![2, 3].includes(schemaVersion)) throw new Error('Unsupported backup schema version');
    const counts = db
      .prepare('SELECT kind,count(*) AS n FROM records GROUP BY kind ORDER BY kind')
      .all() as { kind: string; n: number }[];
    return { schemaVersion, recordCounts: Object.fromEntries(counts.map((r) => [r.kind, r.n])) };
  } finally {
    db.close();
  }
}
async function syncFile(path: string) {
  const f = await open(path, 'r');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function syncDirectory(path: string) {
  const f = await open(path, 'r');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function createBackup(
  sourcePath: string,
  destination: string,
): Promise<BackupManifest> {
  const source = canonicalDatabasePath(sourcePath),
    target = resolve(destination);
  if (source === target) throw new Error('Backup must not overwrite its source');
  if (!(await stat(source)).isFile()) throw new Error('Backup source must be a regular file');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // A create-exclusive reservation serializes cooperating backup commands.
  // Exclusive links below also prevent publication from overwriting other files.
  const reservation = await open(target + '.pending', 'wx', 0o600);
  const temp = `${target}.${randomUUID()}.tmp`,
    manifestTemp = temp + '.manifest.json';
  let db: DatabaseSync | undefined;
  try {
    await requireAbsent(
      [target, target + '.manifest.json', ...sidecars.map((suffix) => target + suffix)],
      'Backup destination already exists or has SQLite sidecars',
    );
    db = new DatabaseSync(source, { readOnly: true });
    await backup(db, temp);
    db.close();
    db = undefined;
    // SQLite's online backup captures committed WAL writes. Convert the copy
    // to a self-contained artifact before hashing; verification must not depend
    // on an unchecksummed WAL or create sidecars on read-only backup storage.
    db = new DatabaseSync(temp);
    const journal = db.prepare('PRAGMA journal_mode=DELETE').get() as { journal_mode: string };
    if (journal.journal_mode !== 'delete')
      throw new Error('Unable to make a self-contained backup');
    db.close();
    db = undefined;
    await chmod(temp, 0o600);
    await requireStandalone(temp);
    const details = inspect(temp);
    const manifest: BackupManifest = {
      format: 'mindtrust-sqlite-backup-v1',
      createdAt: new Date().toISOString(),
      sha256: await digest(temp),
      bytes: (await stat(temp)).size,
      ...details,
    };
    await writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await syncFile(temp);
    await syncFile(manifestTemp);
    await link(temp, target);
    await link(manifestTemp, target + '.manifest.json');
    await syncDirectory(dirname(target));
    return manifest;
  } finally {
    db?.close();
    await unlink(temp).catch(() => {});
    await unlink(manifestTemp).catch(() => {});
    await reservation.close();
    await unlink(target + '.pending').catch(() => {});
    await syncDirectory(dirname(target));
  }
}
export async function verifyBackup(path: string): Promise<BackupManifest> {
  await requireStandalone(path);
  const manifest: BackupManifest = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
  if (
    manifest.format !== 'mindtrust-sqlite-backup-v1' ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  )
    throw new Error('Invalid backup manifest');
  if ((await stat(path)).size !== manifest.bytes || (await digest(path)) !== manifest.sha256)
    throw new Error('Backup checksum does not match its manifest');
  const actual = inspect(path);
  if (
    actual.schemaVersion !== manifest.schemaVersion ||
    JSON.stringify(actual.recordCounts) !== JSON.stringify(manifest.recordCounts)
  )
    throw new Error('Backup schema or record counts do not match its manifest');
  return manifest;
}
export async function restoreBackup(backupPath: string, destination: string) {
  const source = resolve(backupPath);
  const manifest = await verifyBackup(source);
  await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
  const target = canonicalDatabasePath(destination);
  // The same canonical lock used by the server excludes startup during restore.
  // Existing WAL/SHM/journal files are unsafe even when the main file is missing.
  const release = acquireProcessLock(target + '.lock');
  const temp = `${target}.${randomUUID()}.restore.tmp`;
  let published = false;
  try {
    await requireAbsent(
      [target, ...sidecars.map((suffix) => target + suffix)],
      'Restore destination already exists or has SQLite sidecars',
    );
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    await chmod(temp, 0o600);
    if ((await digest(temp)) !== manifest.sha256)
      throw new Error('Restored database checksum does not match');
    inspect(temp);
    await syncFile(temp);
    // The main database appears only once its complete contents are durable.
    // A crash during copy can leave an unused temp file, never a partial DB.
    await link(temp, target);
    published = true;
    await syncDirectory(dirname(target));
    return manifest;
  } catch (error) {
    if (published) await unlink(target).catch(() => {});
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
    try {
      await syncDirectory(dirname(target));
    } finally {
      release();
    }
  }
}
