import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Resolve the database itself (if it exists) and its parent before deriving the
// companion lock. Symlink aliases must not create independent writer locks.
export function canonicalDatabasePath(path: string): string {
  const absolute = resolve(path);
  let existing = false;
  try {
    lstatSync(absolute);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    const canonical = realpathSync(absolute);
    if (statSync(canonical).nlink > 1)
      throw new Error('Database files with hard-link aliases are not supported');
    return canonical;
  }
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

// A separate local SQLite file supplies an OS-backed exclusive lock. Keeping
// its transaction open does not block application writes, and the operating
// system releases it after a crash. This is not a distributed lease: do not
// place either database on a network filesystem.
export function acquireProcessLock(path: string) {
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new Error(
      'Another MindTrust process owns this database, or its local lock is unavailable',
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.exec('ROLLBACK');
    lock.close();
  };
}
