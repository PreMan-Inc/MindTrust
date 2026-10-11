import { createBackup, restoreBackup, verifyBackup } from '../server/backup.ts';
process.umask(0o077);
const [command, source, destination] = process.argv.slice(2);
try {
  if (
    !source ||
    !['create', 'verify', 'restore'].includes(command) ||
    (command !== 'verify' && !destination)
  )
    throw new Error('Usage: npm run backup -- <create|verify|restore> SOURCE [DESTINATION]');
  const result =
    command === 'create'
      ? await createBackup(source, destination)
      : command === 'restore'
        ? await restoreBackup(source, destination)
        : await verifyBackup(source);
  console.log(JSON.stringify({ status: 'ok', command, ...result }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed');
  process.exitCode = 1;
}
