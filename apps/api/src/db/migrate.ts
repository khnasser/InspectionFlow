/**
 * Applies db/migrations/*.sql in order, once each, inside a transaction.
 * Run with an owner connection (superuser or BYPASSRLS):
 *   DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/inspectionflow npm run migrate -w @inspectionflow/api
 * In the API image (Kubernetes migration job): node apps/api/dist/db/migrate.js
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/** db/migrations at the repository (or image) root: four levels up from src/db or dist/db. */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(__dirname, '..', '..', '..', '..', 'db', 'migrations');

export async function migrate(adminUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent runs (two deploys, or a job retried while one is running).
    await client.query(`SELECT pg_advisory_lock(hashtext('inspectionflow:migrate'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((a) => console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date'))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
