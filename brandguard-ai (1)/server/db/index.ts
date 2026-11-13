import { DbAdapter } from './types.js';
import { createPostgresAdapter } from './postgresAdapter.js';
import { createSqliteDevAdapter } from './sqliteDevAdapter.js';
import { ConfigurationError } from '../errors.js';

export interface DatabaseFactoryOptions {
  databaseUrl?: string;
  sqlitePath?: string;
  runMigrations?: boolean;
  migrationsDir?: string;
}

export async function createDatabaseAdapter(options: DatabaseFactoryOptions = {}): Promise<DbAdapter> {
  const isProduction = process.env.NODE_ENV === 'production';
  const databaseUrl = (options.databaseUrl ?? process.env.DATABASE_URL ?? '').trim();

  if (databaseUrl) {
    return createPostgresAdapter({
      connectionString: databaseUrl,
      runMigrations: options.runMigrations,
      migrationsDir: options.migrationsDir,
    });
  }

  if (isProduction) {
    throw new ConfigurationError(
      'DATABASE_URL is required in production. Local SQLite storage is disabled when NODE_ENV=production.'
    );
  }

  console.warn(
    '[DB] DATABASE_URL is not configured; using local SQLite development adapter. Set DATABASE_URL to connect to PostgreSQL.'
  );
  return createSqliteDevAdapter(options.sqlitePath);
}

export type { DbAdapter, DbClient, DbQueryResult } from './types.js';
export { seedStarterWorkspaceForOrg } from './starterSeed.js';
