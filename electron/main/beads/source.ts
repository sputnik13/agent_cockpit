import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface BeadsSource {
  kind: 'sqlite' | 'jsonl';
  path: string;
  schemaCompatible: boolean;
  diagnostics: string[];
}

const SQLITE_CANDIDATES = ['beads.db'];
const JSONL_CANDIDATES = ['issues.jsonl'];

/**
 * Discover the beads data source for a project.
 *
 * The live SQLite DB (`beads.db`) is preferred over the JSONL export. The
 * workgraph must reflect the LATEST committed DB state; `br`'s JSONL export can
 * lag the DB (br flush is not always immediate), so reading JSONL would show a
 * stale view (locked decision on local_repo_explorer-fg5z). The persistent-FD
 * hazard that motivated that issue is addressed elsewhere: every DB read is
 * open-read-close in read-only mode (see `normalize.ts`/`sqlite.ts`), so no
 * handle is pinned for the life of the app, and the workspace watcher no longer
 * walks `.beads/` (see `providers/local/watch.ts`). JSONL remains a fallback
 * for environments that have only the export and no DB.
 */
export function discoverBeadsSource(projectPath: string): BeadsSource | null {
  const beadsDir = join(projectPath, '.beads');
  if (!existsSync(beadsDir)) return null;
  const diagnostics: string[] = [];

  // Prefer the live SQLite DB (open-read-close, read-only; no persistent
  // handle). It carries the latest committed state, including freshly committed
  // WAL rows that the JSONL export has not yet caught up to.
  for (const name of SQLITE_CANDIDATES) {
    const full = join(beadsDir, name);
    if (!existsSync(full)) continue;
    const compat = inspectSqliteSchema(full, diagnostics);
    if (compat) {
      return { kind: 'sqlite', path: full, schemaCompatible: true, diagnostics };
    }
  }

  // Fallback: JSONL export, for environments that have only the export (no DB).
  for (const name of JSONL_CANDIDATES) {
    const full = join(beadsDir, name);
    if (existsSync(full)) {
      return { kind: 'jsonl', path: full, schemaCompatible: true, diagnostics };
    }
  }

  return null;
}

function inspectSqliteSchema(path: string, diagnostics: string[]): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const required = ['issues', 'dependencies'];
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of required) {
      if (!tables.includes(t)) {
        diagnostics.push(`missing table: ${t}`);
        return false;
      }
    }
    // Labels can live either as a column on issues or as a separate table; both fine.
    return true;
  } catch (err) {
    diagnostics.push(`schema check failed: ${(err as Error).message}`);
    return false;
  } finally {
    db?.close();
  }
}
