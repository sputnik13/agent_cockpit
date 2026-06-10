/**
 * Migrations applied in order at app start. Each entry must be idempotent
 * conceptually (we only run unseen versions), and the `version` string must
 * never change after release.
 *
 * Add new migrations as new entries at the end.
 */

export interface Migration {
  version: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: '0001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: '0002_layouts',
    sql: `
      CREATE TABLE IF NOT EXISTS layouts (
        scope TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: '0003_layouts_project_scope',
    sql: `
      -- layouts.scope already supports namespacing (e.g. 'global', 'project:<id>').
      -- This migration is a no-op placeholder for the LA4 contract; logic lives
      -- in the layout service.
      SELECT 1;
    `,
  },
  {
    version: '0004_projects',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        last_opened_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects (last_opened_at);
    `,
  },
  {
    version: '0005_review_state',
    sql: `
      CREATE TABLE IF NOT EXISTS review_state (
        project_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        baseline TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hunk_id TEXT NOT NULL DEFAULT '',
        block_id TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        stale INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, worktree, baseline, file_path, hunk_id, block_id),
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_review_state_worktree ON review_state (project_id, worktree);
      CREATE INDEX IF NOT EXISTS idx_review_state_stale ON review_state (stale);
    `,
  },
  {
    version: '0006_notes',
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_notes_target ON notes (project_id, target_kind, target_id);
    `,
  },
  {
    version: '0007_since_seen',
    sql: `
      CREATE TABLE IF NOT EXISTS review_passes (
        project_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        baseline TEXT NOT NULL,
        started_at TEXT NOT NULL,
        PRIMARY KEY (project_id, worktree, baseline),
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS since_seen (
        project_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        baseline TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hunk_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, worktree, baseline, file_path, hunk_id),
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_since_seen_time ON since_seen (seen_at);
    `,
  },
  {
    version: '0008_agent_cockpit_projects',
    sql: `
      -- App-local cockpit project model: a registry of projects (local or
      -- remote) the user has added, plus a single-row pointer to the active one.
      -- This is independent of the v1 'projects' table and stores the full
      -- ConnectionSpec as JSON.
      CREATE TABLE IF NOT EXISTS agent_cockpit_projects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('local','remote')),
        connection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cockpit_projects_last_active
        ON agent_cockpit_projects (last_active_at);

      -- Single-row pointer table for the active cockpit project. The CHECK on a
      -- constant primary key enforces at most one row.
      CREATE TABLE IF NOT EXISTS agent_cockpit_active_project (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 0),
        id TEXT
      );
    `,
  },
  {
    version: '0009_agent_cockpit_notes',
    sql: `
      -- App-local review notes against a project/worktree/file/hunk/block/bead
      -- target.
      CREATE TABLE IF NOT EXISTS agent_cockpit_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cockpit_notes_project ON agent_cockpit_notes (project_id);
    `,
  },
  {
    version: '0010_agent_cockpit_project_order',
    sql: `
      -- User-controlled persistent project ordering for the top tab strip.
      -- Backfill assigns 0..n-1 matching the prior most-recent-active-first
      -- display so existing registries keep a stable initial order.
      ALTER TABLE agent_cockpit_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_cockpit_projects SET sort_order = (
        SELECT COUNT(*) FROM agent_cockpit_projects p2
         WHERE COALESCE(p2.last_active_at, p2.created_at)
                 > COALESCE(agent_cockpit_projects.last_active_at, agent_cockpit_projects.created_at)
            OR (COALESCE(p2.last_active_at, p2.created_at)
                 = COALESCE(agent_cockpit_projects.last_active_at, agent_cockpit_projects.created_at)
                AND p2.id < agent_cockpit_projects.id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cockpit_projects_sort_order
        ON agent_cockpit_projects (sort_order);
    `,
  },
  {
    version: '0011_agent_cockpit_run_command',
    sql: `
      -- Per-project run command for the Run panel. Nullable: absence means no
      -- command is configured yet. Existing rows backfill to NULL.
      ALTER TABLE agent_cockpit_projects ADD COLUMN run_command TEXT;
    `,
  },
];
