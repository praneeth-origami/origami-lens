import '../load-env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, isDatabaseEnabled } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.log('DATABASE_URL not set — skipping migrations');
    return;
  }

  const pool = getPool();
  if (!pool) throw new Error('Database pool unavailable');

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    console.log(`Applied migration ${file}`);
  }
  console.log('Migrations applied successfully');
}

if (process.argv[1]?.includes('migrate')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
