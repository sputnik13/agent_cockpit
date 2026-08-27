import { readFileSync, statSync } from 'node:fs';
import type { BeadsDep, BeadsIssue, BeadsTaskGraph } from '@shared/ipc/channels';
import { GRAPH_READ_MAX_BYTES } from '@shared/providers/graphReadCap';
import { openBeadsDb } from './sqlite';
import type { BeadsSource } from './source';

interface IssueRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  issue_type: string;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface DepRow {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

interface LabelRow {
  issue_id: string;
  label: string;
}

export function loadGraph(source: BeadsSource): BeadsTaskGraph {
  if (source.kind === 'sqlite') return loadFromSqlite(source);
  return loadFromJsonl(source);
}

/** Max synchronous open-read-close retries when the DB is mid-write (br holding
 *  the write lock). better-sqlite3 surfaces this as SQLITE_BUSY/SQLITE_LOCKED;
 *  we also set a 1s busy_timeout in `openBeadsDb`. A few short retries cover the
 *  brief window between `br` releasing the lock and the next refresh. */
const SQLITE_BUSY_RETRIES = 3;
const SQLITE_RETRY_BACKOFF_MS = 40;

/** True for transient SQLite contention (busy/locked) that a retry can clear. */
function isTransientSqliteError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

/** Synchronous spin-wait between retries. Kept tiny (≤ a few × 40ms) and only
 *  on the contended path; the workgraph read runs off the UI thread in main. */
function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy-wait */
  }
}

function loadFromSqlite(source: BeadsSource): BeadsTaskGraph {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRIES; attempt++) {
    try {
      return loadFromSqliteOnce(source);
    } catch (err) {
      lastErr = err;
      if (!isTransientSqliteError(err) || attempt === SQLITE_BUSY_RETRIES) break;
      sleepSync(SQLITE_RETRY_BACKOFF_MS);
    }
  }
  throw lastErr;
}

/** Single open-read-close pass against the live read-only DB. The handle is
 *  always released (finally) so an external rebuild/repair can take exclusivity
 *  between reads (local_repo_explorer-fg5z). */
function loadFromSqliteOnce(source: BeadsSource): BeadsTaskGraph {
  const db = openBeadsDb(source.path);
  try {
    const issues: BeadsIssue[] = db
      .queryAll<IssueRow>(
        `SELECT id, title, description, status, priority, issue_type, external_ref, created_at, updated_at
         FROM issues WHERE status != 'tombstone'`,
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        body: r.description ?? '',
        status: r.status,
        priority: r.priority ?? 2,
        issueType: r.issue_type,
        labels: [],
        externalRef: r.external_ref,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

    const labelsByIssue = new Map<string, string[]>();
    const labelRows = db.queryAll<LabelRow>(
      `SELECT issue_id, label FROM labels`,
    );
    for (const l of labelRows) {
      const arr = labelsByIssue.get(l.issue_id) ?? [];
      arr.push(l.label);
      labelsByIssue.set(l.issue_id, arr);
    }
    for (const issue of issues) {
      issue.labels = labelsByIssue.get(issue.id) ?? [];
    }

    const deps: BeadsDep[] = db
      .queryAll<DepRow>(`SELECT issue_id, depends_on_id, type FROM dependencies`)
      .map((d) => ({ from: d.issue_id, to: d.depends_on_id, type: d.type }));

    return {
      source: { kind: 'sqlite', path: source.path },
      schemaCompatible: source.schemaCompatible,
      issues,
      deps,
    };
  } finally {
    db.close();
  }
}

function loadFromJsonl(source: BeadsSource): BeadsTaskGraph {
  // Refuse (never silently truncate) an oversized read — mirrors the remote
  // transport exactly (RemoteProvider.getTaskGraph / toTaskGraph in
  // electron/main/providers/remote/index.ts), which throws the same message
  // above the same shared GRAPH_READ_MAX_BYTES cap. Before this, local read
  // the whole file unbounded via readFileSync while remote hard-refused past
  // 10 MiB — the exact same project's workgraph loaded fine locally and
  // hard-failed remotely, with no local repro. A truncated JSONL parse would
  // otherwise silently render as an empty-but-valid "no tasks" graph with no
  // indication anything is wrong.
  const { size } = statSync(source.path);
  if (size > GRAPH_READ_MAX_BYTES) {
    throw new Error(
      `.beads/issues.jsonl is too large to read (over ${String(GRAPH_READ_MAX_BYTES / (1 << 20))} MiB); ` +
        'the workgraph cannot be loaded until it is pruned (e.g. tombstone compaction via br).',
    );
  }
  const text = readFileSync(source.path, 'utf8');
  const issues: BeadsIssue[] = [];
  const deps: BeadsDep[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['status'] === 'tombstone') continue;
    issues.push({
      id: String(parsed['id']),
      title: String(parsed['title'] ?? ''),
      body: String(parsed['description'] ?? ''),
      status: String(parsed['status'] ?? 'open'),
      priority: Number(parsed['priority'] ?? 2),
      issueType: String(parsed['issue_type'] ?? 'task'),
      labels: Array.isArray(parsed['labels']) ? (parsed['labels'] as string[]) : [],
      externalRef: (parsed['external_ref'] as string | undefined) ?? null,
      createdAt: String(parsed['created_at'] ?? ''),
      updatedAt: String(parsed['updated_at'] ?? ''),
    });
    if (Array.isArray(parsed['dependencies'])) {
      for (const d of parsed['dependencies'] as Array<{
        issue_id: string;
        depends_on_id: string;
        type: string;
      }>) {
        deps.push({ from: d.issue_id, to: d.depends_on_id, type: d.type });
      }
    }
  }
  return {
    source: { kind: 'jsonl', path: source.path },
    schemaCompatible: source.schemaCompatible,
    issues,
    deps,
  };
}
