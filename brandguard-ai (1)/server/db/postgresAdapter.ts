import { Pool, PoolClient, PoolConfig } from 'pg';
import { DbAdapter, DbClient, DbQueryResult } from './types.js';
import { runPostgresMigrations } from './postgresMigrator.js';
import { ConfigurationError, DatabaseUnavailableError } from '../errors.js';

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  '3D000',
  '28P01',
  '28000',
]);

export function isDatabaseConnectionError(err: any): boolean {
  if (!err) return false;
  if (typeof err.code === 'string' && CONNECTION_ERROR_CODES.has(err.code)) {
    return true;
  }
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('connect econnrefused') ||
    msg.includes('timeout expired') ||
    msg.includes('too many clients') ||
    msg.includes('server closed the connection unexpectedly')
  );
}

export function resolvePostgresSslConfig(connectionString: string): PoolConfig['ssl'] {
  const mode = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (mode === 'disable' || mode === 'false' || mode === 'off') {
    return false;
  }
  if (mode === 'verify-full' || mode === 'strict') {
    return { rejectUnauthorized: true };
  }
  if (mode === 'require' || mode === 'no-verify' || mode === 'true') {
    return { rejectUnauthorized: false };
  }
  // Auto-detect common local hosts vs managed cloud endpoints
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1') ||
    connectionString.includes('sslmode=disable');
  return isLocal ? false : { rejectUnauthorized: false };
}

function wrapClient(client: Pick<PoolClient, 'query'>): DbClient {
  return {
    async query<T = any>(sql: string, params: any[] = []): Promise<DbQueryResult<T>> {
      try {
        const res = await client.query(sql, params);
        return {
          rows: res.rows as T[],
          rowCount: res.rowCount ?? res.rows.length,
        };
      } catch (err: any) {
        if (isDatabaseConnectionError(err)) {
          throw new DatabaseUnavailableError('PostgreSQL database service is unavailable.', { cause: err });
        }
        throw err;
      }
    },
    async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
      const res = await this.query<T>(sql, params);
      return res.rows[0] ?? null;
    },
  };
}

export interface PostgresAdapterOptions {
  connectionString: string;
  maxConnections?: number;
  runMigrations?: boolean;
  migrationsDir?: string;
}

export async function createPostgresAdapter(options: PostgresAdapterOptions): Promise<DbAdapter> {
  if (!options.connectionString || !options.connectionString.trim()) {
    throw new ConfigurationError('DATABASE_URL is required to connect to PostgreSQL.');
  }

  const maxFromEnv = Number(process.env.DATABASE_POOL_MAX || '10');
  const max = options.maxConnections ?? (Number.isFinite(maxFromEnv) && maxFromEnv > 0 ? maxFromEnv : 10);

  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: resolvePostgresSslConfig(options.connectionString),
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected idle PostgreSQL pool client error:', err.message);
  });

  if (options.runMigrations !== false) {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await runPostgresMigrations(client, options.migrationsDir);
    } catch (err: any) {
      await pool.end().catch(() => undefined);
      if (isDatabaseConnectionError(err)) {
        throw new DatabaseUnavailableError('Failed to connect to PostgreSQL database.', { cause: err });
      }
      throw err;
    } finally {
      client?.release();
    }
  }

  const rootQueryable = wrapClient(pool);

  return {
    dialect: 'postgres',
    query: rootQueryable.query.bind(rootQueryable),
    queryOne: rootQueryable.queryOne.bind(rootQueryable),
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (err: any) {
        throw new DatabaseUnavailableError('PostgreSQL database service is unavailable.', { cause: err });
      }

      const txQueryable = wrapClient(client);
      try {
        await client.query('BEGIN');
        const result = await fn(txQueryable);
        await client.query('COMMIT');
        return result;
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isDatabaseConnectionError(err)) {
          throw new DatabaseUnavailableError('PostgreSQL connection interrupted during transaction.', { cause: err });
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async healthCheck(): Promise<void> {
      try {
        await pool.query('SELECT 1 AS ok');
      } catch (err: any) {
        throw new DatabaseUnavailableError('PostgreSQL health check failed.', { cause: err });
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
