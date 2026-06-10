/**
 * App-local cockpit project store.
 *
 * Persists the registry of projects (local or remote) the user has added to
 * Agent Cockpit, plus a pointer to the currently active project. This model is
 * purely app-local metadata: removing a project here never touches the
 * underlying repository, remote host, or any worktree — it only forgets the
 * entry. The full {@link ConnectionSpec} is serialized to JSON per row.
 *
 * Public functions operate on the shared {@link getDb} handle. Each is a thin
 * wrapper over a `*On(db, ...)` core that takes an explicit database, so tests
 * can drive an in-memory database without touching userData.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type Database from 'better-sqlite3';
import type { ConnectionSpec, ProjectKind, RemoteConnectionSpec } from '@shared/providers/types';
import { getDb } from './sqlite';

type DB = Database.Database;

/** A registered cockpit project (app-local metadata only). */
export interface CockpitProject {
  id: string;
  label: string;
  kind: ProjectKind;
  connection: ConnectionSpec;
  createdAt: string;
  lastActiveAt: string | null;
  /** Command executed by the Run panel; null when none is configured. */
  runCommand: string | null;
}

interface ProjectRow {
  id: string;
  label: string;
  kind: string;
  connection_json: string;
  created_at: string;
  last_active_at: string | null;
  run_command: string | null;
}

const ACTIVE_SINGLETON = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function deserializeConnection(json: string): ConnectionSpec {
  return JSON.parse(json) as ConnectionSpec;
}

function rowToProject(row: ProjectRow): CockpitProject {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as ProjectKind,
    connection: deserializeConnection(row.connection_json),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    runCommand: row.run_command,
  };
}

// ---- Core (explicit db) ----------------------------------------------------

/** List all cockpit projects in their persistent user-controlled order. */
export function listProjectsOn(db: DB): CockpitProject[] {
  const rows = db
    .prepare<[], ProjectRow>(
      `SELECT id, label, kind, connection_json, created_at, last_active_at, run_command
         FROM agent_cockpit_projects
         ORDER BY sort_order ASC, created_at ASC`,
    )
    .all();
  return rows.map(rowToProject);
}

/** Fetch a single cockpit project by id, or `null` if it does not exist. */
export function getProjectOn(db: DB, id: string): CockpitProject | null {
  const row = db
    .prepare<[string], ProjectRow>(
      `SELECT id, label, kind, connection_json, created_at, last_active_at, run_command
         FROM agent_cockpit_projects
         WHERE id = ?`,
    )
    .get(id);
  return row ? rowToProject(row) : null;
}

/**
 * Add a new cockpit project. The kind is derived from `connection.kind`; an
 * explicit `kind` passed alongside a mismatched connection is rejected upstream
 * (callers supply only the connection here). Generates a stable id and an ISO
 * `createdAt`.
 */
export function addProjectOn(
  db: DB,
  input: { label: string; connection: ConnectionSpec },
): CockpitProject {
  const { label, connection } = input;
  const kind = connection.kind;
  // Defensive: ConnectionSpec.kind is the single source of truth for kind.
  if (kind !== 'local' && kind !== 'remote') {
    throw new Error(`invalid connection kind: ${String(kind)}`);
  }

  const id = randomUUID();
  const createdAt = nowIso();
  const connectionJson = JSON.stringify(connection);

  // New projects append to the end of the user-controlled order.
  db.prepare(
    `INSERT INTO agent_cockpit_projects
       (id, label, kind, connection_json, created_at, last_active_at, sort_order)
       VALUES (?, ?, ?, ?, ?, NULL,
         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM agent_cockpit_projects))`,
  ).run(id, label, kind, connectionJson, createdAt);

  return {
    id,
    label,
    kind,
    connection,
    createdAt,
    lastActiveAt: null,
    runCommand: null,
  };
}

/** Set (or clear, with `null`) a project's Run-panel command. */
export function setProjectRunCommandOn(db: DB, id: string, command: string | null): void {
  db.prepare('UPDATE agent_cockpit_projects SET run_command = ? WHERE id = ?').run(command, id);
}

/**
 * Patch an existing project's label and/or connection spec. Kind is immutable:
 * if `patch.connection` is provided its `kind` must match the stored kind.
 * Throws if the project is not found or if the kind would change.
 */
export function updateProjectOn(
  db: DB,
  id: string,
  patch: { label?: string; connection?: ConnectionSpec },
): CockpitProject {
  const existing = getProjectOn(db, id);
  if (!existing) throw new Error(`project not found: ${id}`);
  if (patch.connection && patch.connection.kind !== existing.kind) {
    throw new Error(
      `cannot change project kind (existing=${existing.kind}, new=${patch.connection.kind})`,
    );
  }
  const newLabel = patch.label ?? existing.label;
  const newConnection = patch.connection ?? existing.connection;
  const newConnectionJson = JSON.stringify(newConnection);
  db.prepare(
    'UPDATE agent_cockpit_projects SET label = ?, connection_json = ? WHERE id = ?',
  ).run(newLabel, newConnectionJson, id);
  return getProjectOn(db, id)!;
}

/**
 * Persist a new project order. `orderedIds` is the full set of project ids in
 * the desired left-to-right (top tab) order; each project's `sort_order` is set
 * to its index. Ids not present are left untouched (and will sort after, by
 * their stale order). Runs in a single transaction.
 */
export function reorderProjectsOn(db: DB, orderedIds: string[]): void {
  const update = db.prepare('UPDATE agent_cockpit_projects SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, id));
  })();
}

/**
 * Remove a cockpit project. App-local only — this never touches the underlying
 * repository or remote host. If the removed project was active, the active
 * pointer is cleared atomically.
 */
export function removeProjectOn(db: DB, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_cockpit_projects WHERE id = ?').run(id);
    const active = getActiveProjectIdOn(db);
    if (active === id) {
      setActiveProjectIdOn(db, null);
    }
  })();
}

/** Mark a project as just-active by setting `last_active_at` to now (ISO). */
export function touchProjectOn(db: DB, id: string): void {
  db.prepare('UPDATE agent_cockpit_projects SET last_active_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Get the active project id, or `null` if none is set. */
export function getActiveProjectIdOn(db: DB): string | null {
  const row = db
    .prepare<[number], { id: string | null }>(
      'SELECT id FROM agent_cockpit_active_project WHERE singleton = ?',
    )
    .get(ACTIVE_SINGLETON);
  return row ? row.id : null;
}

/**
 * Set (or clear, with `null`) the active project pointer. Validates that a
 * non-null id refers to an existing project.
 */
export function setActiveProjectIdOn(db: DB, id: string | null): void {
  if (id !== null && getProjectOn(db, id) === null) {
    throw new Error(`cannot set active project: no such project ${id}`);
  }
  db.prepare(
    `INSERT INTO agent_cockpit_active_project (singleton, id)
       VALUES (?, ?)
       ON CONFLICT(singleton) DO UPDATE SET id = excluded.id`,
  ).run(ACTIVE_SINGLETON, id);
}

// ---- Public API (shared db) ------------------------------------------------

/** List all cockpit projects in their persistent user-controlled order. */
export function listProjects(): CockpitProject[] {
  return listProjectsOn(getDb());
}

/** Persist a new project order (full ordered id list). */
export function reorderProjects(orderedIds: string[]): void {
  reorderProjectsOn(getDb(), orderedIds);
}

/** Fetch a single cockpit project by id, or `null` if it does not exist. */
export function getProject(id: string): CockpitProject | null {
  return getProjectOn(getDb(), id);
}

/** Add a new cockpit project, deriving kind from `connection.kind`. */
export function addProject(input: { label: string; connection: ConnectionSpec }): CockpitProject {
  return addProjectOn(getDb(), input);
}

/** Remove a cockpit project (app-local only); clears active pointer if needed. */
export function removeProject(id: string): void {
  removeProjectOn(getDb(), id);
}

/** Mark a project as just-active (sets `last_active_at` to now). */
export function touchProject(id: string): void {
  touchProjectOn(getDb(), id);
}

/** Set (or clear) a project's Run-panel command. */
export function setProjectRunCommand(id: string, command: string | null): void {
  setProjectRunCommandOn(getDb(), id, command);
}

/** Get the active project id, or `null` if none is set. */
export function getActiveProjectId(): string | null {
  return getActiveProjectIdOn(getDb());
}

/** Set (or clear) the active project pointer. */
export function setActiveProjectId(id: string | null): void {
  setActiveProjectIdOn(getDb(), id);
}

/** Update an existing project's label and/or connection spec. */
export function updateProject(
  id: string,
  patch: { label?: string; connection?: ConnectionSpec },
): CockpitProject {
  return updateProjectOn(getDb(), id, patch);
}

// ---- Remote project relabel (one-time migration) ---------------------------

/**
 * POSIX basename of a remote path: strips trailing slashes and returns the
 * last segment. Mirrors the renderer-side `basename()` in `ProjectTabs.tsx`
 * so the label computed here and the label computed at add-time agree exactly.
 */
function remotePosixBasename(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const last = posix.basename(trimmed);
  return last || remotePath;
}

/**
 * Compute the preferred name-first label for a remote project given its base
 * name and the existing set of already-computed labels (in insertion order,
 * i.e. by sort_order / created_at).
 *
 * Rules (mirrors `remoteProjectLabel` in `src/renderer/shell/ProjectTabs.tsx`):
 *   - If `base` is not yet taken → use `base` directly.
 *   - If `base` is taken → use `${base} (${user}@${host})`.
 *   - If that is taken → append ` 2`, ` 3`, … until unique.
 */
export function computeRemoteLabel(
  base: string,
  user: string,
  host: string,
  alreadyUsed: ReadonlySet<string>,
): string {
  if (!alreadyUsed.has(base)) return base;
  const qualified = `${base} (${user}@${host})`;
  if (!alreadyUsed.has(qualified)) return qualified;
  let n = 2;
  while (alreadyUsed.has(`${qualified} ${n}`)) n += 1;
  return `${qualified} ${n}`;
}

/**
 * Return true if `label` is already in name-first form for this remote project.
 *
 * A label is "name-first" when it begins with `base` (the `basename` of the
 * remote path). Labels in the old format look like `host:basename`,
 * `user@host:basename`, or the raw remote path — none of which start with the
 * bare project name.
 */
function isAlreadyNameFirst(label: string, base: string): boolean {
  // Exact match (no conflict suffix) or starts with "base (" (with suffix).
  return label === base || label.startsWith(`${base} (`);
}

/**
 * One-time idempotent relabel of all remote projects whose stored label is NOT
 * already in name-first form. Local project labels are untouched. The relabeled
 * projects are processed in sort_order / created_at order so conflict suffixes
 * are deterministic (same order across runs).
 *
 * Returns the number of projects relabeled.
 */
export function relabelRemoteProjectsOn(db: DB): number {
  const rows = db
    .prepare<[], ProjectRow>(
      `SELECT id, label, kind, connection_json, created_at, last_active_at, run_command
         FROM agent_cockpit_projects
         WHERE kind = 'remote'
         ORDER BY sort_order ASC, created_at ASC`,
    )
    .all();

  if (rows.length === 0) return 0;

  const update = db.prepare('UPDATE agent_cockpit_projects SET label = ? WHERE id = ?');

  // Track labels assigned during this pass so conflicts within the batch are
  // resolved correctly (projects that already had the correct label still hold
  // their label slot).
  const assignedLabels = new Set<string>();

  // First pass: register labels of projects that are already name-first so
  // they "occupy" their slot before we recompute the others.
  for (const row of rows) {
    const conn = JSON.parse(row.connection_json) as RemoteConnectionSpec;
    const base = remotePosixBasename(conn.remotePath);
    if (isAlreadyNameFirst(row.label, base)) {
      assignedLabels.add(row.label);
    }
  }

  let count = 0;
  return db.transaction(() => {
    for (const row of rows) {
      const conn = JSON.parse(row.connection_json) as RemoteConnectionSpec;
      const base = remotePosixBasename(conn.remotePath);
      if (isAlreadyNameFirst(row.label, base)) {
        // Already correct; its label is already in assignedLabels from pass 1.
        continue;
      }
      // Compute the new name-first label, avoiding collisions with labels
      // already assigned in this pass.
      const newLabel = computeRemoteLabel(base, conn.user, conn.host, assignedLabels);
      update.run(newLabel, row.id);
      assignedLabels.add(newLabel);
      count += 1;
    }
    return count;
  })();
}

/** One-time relabel against the shared DB (called at app startup). */
export function relabelRemoteProjects(): number {
  return relabelRemoteProjectsOn(getDb());
}
