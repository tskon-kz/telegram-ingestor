import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { databaseUrlFromEnv } from '../config/index.js';

// dist/entrypoints/migrate.js -> /app/migrations (copied alongside dist).
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

async function main(): Promise<void> {
  const applied = await runner({
    databaseUrl: databaseUrlFromEnv(),
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: (msg: string) => console.log(msg),
  });
  console.log(`migrations complete: ${applied.length} applied`);
  process.exit(0);
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
