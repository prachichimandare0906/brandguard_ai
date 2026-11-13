import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SqlMigrationFile {
  id: string;
  name: string;
  filePath: string;
  sql: string;
  checksum: string;
}

export function getMigrationsDir(): string {
  const fromModule = path.resolve(__dirname, 'migrations');
  if (fs.existsSync(fromModule)) return fromModule;
  return path.resolve(process.cwd(), 'server', 'db', 'migrations');
}

export function loadSqlMigrations(migrationsDir = getMigrationsDir()): SqlMigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    const id = file.replace(/\.sql$/, '');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    return {
      id,
      name: file,
      filePath,
      sql,
      checksum,
    };
  });
}

const ADVISORY_LOCK_KEY = 884201;

export async function runPostgresMigrations(
  client: Pick<PoolClient, 'query'>,
  migrationsDir = getMigrationsDir()
): Promise<string[]> {
  const migrations = loadSqlMigrations(migrationsDir);
  const appliedNow: string[] = [];

  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const existingRes = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations'
    );
    const existingMap = new Map(existingRes.rows.map((r) => [r.id, r.checksum]));

    for (const migration of migrations) {
      const existingChecksum = existingMap.get(migration.id);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration checksum mismatch for ${migration.id}. Refusing to alter an already-applied migration.`
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [migration.id, migration.name, migration.checksum]
        );
        await client.query('COMMIT');
        appliedNow.push(migration.id);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }

    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
  }
}
