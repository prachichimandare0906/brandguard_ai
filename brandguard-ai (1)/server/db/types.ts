export interface DbQueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<DbQueryResult<T>>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

export interface DbAdapter extends DbClient {
  dialect: 'postgres' | 'sqlite';
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}
