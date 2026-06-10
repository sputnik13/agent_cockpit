import Database from 'better-sqlite3';

export interface ReadOnlyBeadsDb {
  raw: Database.Database;
  close(): void;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  querySingle<T>(sql: string, params?: unknown[]): T | null;
}

export function openBeadsDb(path: string): ReadOnlyBeadsDb {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return {
    raw: db,
    close: () => db.close(),
    queryAll<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    querySingle<T>(sql: string, params: unknown[] = []) {
      const r = db.prepare(sql).get(...(params as never[]));
      return (r ?? null) as T | null;
    },
  };
}
