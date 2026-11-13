import { DBInstance, initDatabase } from '../db.js';
import { DbAdapter, DbClient, DbQueryResult } from './types.js';
import { ConfigurationError, DatabaseUnavailableError } from '../errors.js';

function translatePostgresParamsToSqlite(sql: string, params: any[] = []): { sql: string; params: any[] } {
  const orderedParams: any[] = [];
  const translatedSql = sql.replace(/\$(\d+)\b/g, (_match, indexStr) => {
    const idx = Number(indexStr) - 1;
    if (idx < 0 || idx >= params.length) {
      throw new Error(`Missing SQL parameter $${indexStr} for query`);
    }
    const val = params[idx];
    if (typeof val === 'boolean') {
      orderedParams.push(val ? 1 : 0);
    } else if (val instanceof Date) {
      orderedParams.push(val.toISOString());
    } else {
      orderedParams.push(val);
    }
    return '?';
  });

  // Remove PostgreSQL-specific jsonb cast syntax if present in SQL
  const cleanedSql = translatedSql.replace(/::jsonb\b/gi, '');
  return { sql: cleanedSql, params: orderedParams };
}

function createSqliteClient(instance: DBInstance): DbClient {
  return {
    async query<T = any>(sql: string, params: any[] = []): Promise<DbQueryResult<T>> {
      try {
        const { sql: sqliteSql, params: sqliteParams } = translatePostgresParamsToSqlite(sql, params);
        const stmt = instance.prepare(sqliteSql);
        if (stmt.reader) {
          const rows = stmt.all(...sqliteParams) as T[];
          return { rows, rowCount: rows.length };
        }
        const info = stmt.run(...sqliteParams);
        return { rows: [], rowCount: info.changes };
      } catch (err: any) {
        if (err?.code === 'SQLITE_CANTOPEN' || err?.code === 'SQLITE_BUSY') {
          throw new DatabaseUnavailableError('Local SQLite development database is unavailable.', { cause: err });
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

export function createSqliteDevAdapter(dbPath?: string): DbAdapter {
  if (process.env.NODE_ENV === 'production') {
    throw new ConfigurationError(
      'SQLite is disabled in production. Set DATABASE_URL to a managed PostgreSQL instance.'
    );
  }

  const instance = initDatabase(dbPath);
  const client = createSqliteClient(instance);

  return {
    dialect: 'sqlite',
    query: client.query.bind(client),
    queryOne: client.queryOne.bind(client),
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      instance.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(client);
        instance.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          instance.exec('ROLLBACK');
        } catch {
          // ignore rollback error if transaction already closed
        }
        throw err;
      }
    },
    async healthCheck(): Promise<void> {
      instance.prepare('SELECT 1 AS ok').get();
    },
    async close(): Promise<void> {
      instance.close();
    },
  };
}
