import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConnectionSpec,
  LocalConnectionSpec,
  RemoteConnectionSpec,
} from '@shared/providers/types';
import { migrations } from './migrations';
import {
  addProjectOn,
  computeRemoteLabel,
  getActiveProjectIdOn,
  getProjectOn,
  listProjectsOn,
  relabelRemoteProjectsOn,
  removeProjectOn,
  reorderProjectsOn,
  setActiveProjectIdOn,
  setProjectRunCommandOn,
  touchProjectOn,
  updateProjectOn,
} from './projects';

type DB = Database.Database;

const local: LocalConnectionSpec = { kind: 'local', rootPath: '/repos/alpha' };
const remote: RemoteConnectionSpec = {
  kind: 'remote',
  host: 'box.example',
  user: 'dev',
  port: 22,
  identityPath: '/home/dev/.ssh/id_ed25519',
  remotePath: '/srv/beta',
};

function migration(version: string): string {
  const m = migrations.find((x) => x.version === version);
  if (!m) throw new Error(`missing migration ${version}`);
  return m.sql;
}

// better-sqlite3 ships a native binding compiled for Electron's ABI in this
// repo (electron-rebuild), so it cannot load under the plain-Node vitest
// runtime. Skip native-DB tests when the binding can't open; they execute
// wherever the ABI matches (CI node-build or the Electron integration runner
// in the validation phase). The store logic is still typechecked here.
function dbUsable(): boolean {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

const describeDb = dbUsable() ? describe : describe.skip;

describeDb('cockpit projects store', () => {
  let db: DB;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(migration('0008_agent_cockpit_projects'));
    db.exec(migration('0010_agent_cockpit_project_order'));
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a local project including its connection spec', () => {
    const created = addProjectOn(db, { label: 'Alpha', connection: local });
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe('local');
    expect(created.lastActiveAt).toBeNull();
    expect(created.createdAt).toMatch(/\dT\d/);

    const fetched = getProjectOn(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.connection).toEqual(local);
    expect(fetched?.label).toBe('Alpha');
  });

  it('round-trips a remote project including its connection spec', () => {
    const created = addProjectOn(db, { label: 'Beta', connection: remote });
    expect(created.kind).toBe('remote');

    const fetched = getProjectOn(db, created.id);
    expect(fetched?.connection).toEqual(remote);
  });

  it('lists projects in insertion order by default (new projects append)', () => {
    const a = addProjectOn(db, { label: 'A', connection: local });
    const b = addProjectOn(db, { label: 'B', connection: remote });
    const c = addProjectOn(db, { label: 'C', connection: local });
    // Activity (touch) no longer affects order — only explicit reorder does.
    touchProjectOn(db, a.id);

    expect(listProjectsOn(db).map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });

  it('reorderProjectsOn persists a new left-to-right order', () => {
    const a = addProjectOn(db, { label: 'A', connection: local });
    const b = addProjectOn(db, { label: 'B', connection: remote });
    const c = addProjectOn(db, { label: 'C', connection: local });

    reorderProjectsOn(db, [c.id, a.id, b.id]);
    expect(listProjectsOn(db).map((p) => p.id)).toEqual([c.id, a.id, b.id]);

    // A project added after a reorder appends to the end.
    const d = addProjectOn(db, { label: 'D', connection: local });
    expect(listProjectsOn(db).map((p) => p.id)).toEqual([c.id, a.id, b.id, d.id]);
  });

  it('getProject returns null for an unknown id', () => {
    expect(getProjectOn(db, 'nope')).toBeNull();
  });

  it('defaults runCommand to null and round-trips set/clear', () => {
    const p = addProjectOn(db, { label: 'A', connection: local });
    expect(p.runCommand).toBeNull();
    expect(getProjectOn(db, p.id)?.runCommand).toBeNull();

    setProjectRunCommandOn(db, p.id, 'npm run dev');
    expect(getProjectOn(db, p.id)?.runCommand).toBe('npm run dev');

    setProjectRunCommandOn(db, p.id, null);
    expect(getProjectOn(db, p.id)?.runCommand).toBeNull();
  });

  it('touchProject updates last_active_at', () => {
    const p = addProjectOn(db, { label: 'A', connection: local });
    expect(getProjectOn(db, p.id)?.lastActiveAt).toBeNull();

    touchProjectOn(db, p.id);
    const touched = getProjectOn(db, p.id);
    expect(touched?.lastActiveAt).not.toBeNull();
    expect(touched?.lastActiveAt).toMatch(/\dT\d/);
  });

  it('sets, gets, and clears the active project pointer', () => {
    expect(getActiveProjectIdOn(db)).toBeNull();

    const p = addProjectOn(db, { label: 'A', connection: local });
    setActiveProjectIdOn(db, p.id);
    expect(getActiveProjectIdOn(db)).toBe(p.id);

    const q = addProjectOn(db, { label: 'B', connection: remote });
    setActiveProjectIdOn(db, q.id);
    expect(getActiveProjectIdOn(db)).toBe(q.id);

    setActiveProjectIdOn(db, null);
    expect(getActiveProjectIdOn(db)).toBeNull();
  });

  it('rejects setting an active project that does not exist', () => {
    expect(() => setActiveProjectIdOn(db, 'ghost')).toThrow();
  });

  it('removeProject clears the active pointer when the active project is removed', () => {
    const p = addProjectOn(db, { label: 'A', connection: local });
    setActiveProjectIdOn(db, p.id);
    expect(getActiveProjectIdOn(db)).toBe(p.id);

    removeProjectOn(db, p.id);
    expect(getProjectOn(db, p.id)).toBeNull();
    expect(getActiveProjectIdOn(db)).toBeNull();
  });

  it('removeProject leaves a different active pointer intact', () => {
    const active = addProjectOn(db, { label: 'A', connection: local });
    const other = addProjectOn(db, { label: 'B', connection: remote });
    setActiveProjectIdOn(db, active.id);

    removeProjectOn(db, other.id);
    expect(getActiveProjectIdOn(db)).toBe(active.id);
  });

  it('rejects an invalid connection kind', () => {
    const bad = { kind: 'sftp', rootPath: '/x' } as unknown as ConnectionSpec;
    expect(() => addProjectOn(db, { label: 'Bad', connection: bad })).toThrow();
  });

  it('enforces the kind CHECK constraint at the schema level', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_cockpit_projects (id, label, kind, connection_json, created_at)
             VALUES ('x', 'X', 'cloud', '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });
});

// ---- computeRemoteLabel (pure logic — no DB needed) ------------------------

describe('computeRemoteLabel', () => {
  it('returns base name when no conflict exists', () => {
    expect(computeRemoteLabel('myrepo', 'dev', 'box.example', new Set())).toBe('myrepo');
  });

  it('qualifies with user@host when base name is taken', () => {
    const used = new Set(['myrepo']);
    expect(computeRemoteLabel('myrepo', 'dev', 'box.example', used)).toBe('myrepo (dev@box.example)');
  });

  it('appends a counter when base and qualified are both taken', () => {
    const used = new Set(['myrepo', 'myrepo (dev@box.example)']);
    expect(computeRemoteLabel('myrepo', 'dev', 'box.example', used)).toBe('myrepo (dev@box.example) 2');
  });

  it('keeps incrementing the counter past 2', () => {
    const used = new Set(['myrepo', 'myrepo (dev@box.example)', 'myrepo (dev@box.example) 2']);
    expect(computeRemoteLabel('myrepo', 'dev', 'box.example', used)).toBe('myrepo (dev@box.example) 3');
  });
});

// ---- relabelRemoteProjectsOn -----------------------------------------------

describeDb('relabelRemoteProjectsOn', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(migration('0008_agent_cockpit_projects'));
    db.exec(migration('0010_agent_cockpit_project_order'));
    db.exec(migration('0011_agent_cockpit_run_command'));
  });

  afterEach(() => {
    db.close();
  });

  it('relabels a remote project whose label is host:basename format', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    addProjectOn(db, { label: 'box.example:myrepo', connection: conn });

    const count = relabelRemoteProjectsOn(db);
    expect(count).toBe(1);
    const projects = listProjectsOn(db);
    expect(projects[0]?.label).toBe('myrepo');
  });

  it('does not relabel a remote project that is already name-first (exact match)', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    addProjectOn(db, { label: 'myrepo', connection: conn });

    const count = relabelRemoteProjectsOn(db);
    expect(count).toBe(0);
    expect(listProjectsOn(db)[0]?.label).toBe('myrepo');
  });

  it('does not relabel a remote project that has a name-first qualified label', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    addProjectOn(db, { label: 'myrepo (dev@box.example)', connection: conn });

    const count = relabelRemoteProjectsOn(db);
    expect(count).toBe(0);
    expect(listProjectsOn(db)[0]?.label).toBe('myrepo (dev@box.example)');
  });

  it('resolves conflicts across a batch: two projects with the same basename on different hosts', () => {
    const conn1: RemoteConnectionSpec = {
      kind: 'remote', host: 'host1.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    const conn2: RemoteConnectionSpec = {
      kind: 'remote', host: 'host2.example', user: 'dev', port: 22, remotePath: '/repos/myrepo',
    };
    addProjectOn(db, { label: 'host1.example:myrepo', connection: conn1 });
    addProjectOn(db, { label: 'host2.example:myrepo', connection: conn2 });

    const count = relabelRemoteProjectsOn(db);
    expect(count).toBe(2);
    const labels = listProjectsOn(db).map((p) => p.label);
    expect(labels).toContain('myrepo');
    expect(labels).toContain('myrepo (dev@host2.example)');
  });

  it('does not touch local project labels', () => {
    const localConn: LocalConnectionSpec = { kind: 'local', rootPath: '/repos/alpha' };
    addProjectOn(db, { label: 'host:project', connection: localConn });

    const count = relabelRemoteProjectsOn(db);
    expect(count).toBe(0);
    expect(listProjectsOn(db)[0]?.label).toBe('host:project');
  });

  it('is idempotent: a second run relabels nothing', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    addProjectOn(db, { label: 'box.example:myrepo', connection: conn });

    relabelRemoteProjectsOn(db);
    const count2 = relabelRemoteProjectsOn(db);
    expect(count2).toBe(0);
    expect(listProjectsOn(db)[0]?.label).toBe('myrepo');
  });
});

// ---- updateProjectOn -------------------------------------------------------

describeDb('updateProjectOn', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(migration('0008_agent_cockpit_projects'));
    db.exec(migration('0010_agent_cockpit_project_order'));
    db.exec(migration('0011_agent_cockpit_run_command'));
  });

  afterEach(() => {
    db.close();
  });

  it('updates the label of an existing project', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    const p = addProjectOn(db, { label: 'myrepo', connection: conn });
    const updated = updateProjectOn(db, p.id, { label: 'renamed' });
    expect(updated.label).toBe('renamed');
    expect(getProjectOn(db, p.id)?.label).toBe('renamed');
  });

  it('updates the connection spec of a remote project', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'old.host', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    const p = addProjectOn(db, { label: 'myrepo', connection: conn });
    const newConn: RemoteConnectionSpec = { ...conn, host: 'new.host', port: 2222 };
    const updated = updateProjectOn(db, p.id, { connection: newConn });
    expect(updated.connection.kind).toBe('remote');
    if (updated.connection.kind === 'remote') {
      expect(updated.connection.host).toBe('new.host');
      expect(updated.connection.port).toBe(2222);
    }
  });

  it('throws when trying to change the project kind', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    const p = addProjectOn(db, { label: 'myrepo', connection: conn });
    const localConn: ConnectionSpec = { kind: 'local', rootPath: '/repos/alpha' };
    expect(() => updateProjectOn(db, p.id, { connection: localConn })).toThrow(/cannot change project kind/);
  });

  it('throws when the project does not exist', () => {
    expect(() => updateProjectOn(db, 'ghost-id', { label: 'new' })).toThrow(/project not found/);
  });

  it('preserves unreferenced fields (runCommand, sort_order)', () => {
    const conn: RemoteConnectionSpec = {
      kind: 'remote', host: 'box.example', user: 'dev', port: 22, remotePath: '/srv/myrepo',
    };
    const p = addProjectOn(db, { label: 'myrepo', connection: conn });
    setProjectRunCommandOn(db, p.id, 'npm start');
    updateProjectOn(db, p.id, { label: 'renamed' });
    const after = getProjectOn(db, p.id);
    expect(after?.runCommand).toBe('npm start');
  });
});
