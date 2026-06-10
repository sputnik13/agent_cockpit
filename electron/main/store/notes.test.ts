import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrations } from './migrations';
import {
  createNoteOn,
  deleteNoteOn,
  exportNotesMarkdown,
  listNotesOn,
  updateNoteOn,
} from './notes';

function dbUsable(): boolean {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}
const describeDb = dbUsable() ? describe : describe.skip;

function migration(version: string): string {
  const m = migrations.find((x) => x.version === version);
  if (!m) throw new Error(`missing migration ${version}`);
  return m.sql;
}

describeDb('cockpit notes store', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(migration('0009_agent_cockpit_notes'));
  });
  afterEach(() => db.close());

  it('creates, lists, updates and deletes notes', () => {
    const a = createNoteOn(db, { projectId: 'p', targetKind: 'project', targetId: 'p', body: 'first' });
    createNoteOn(db, { projectId: 'p', targetKind: 'file', targetId: 'x.ts', body: 'second' });
    expect(listNotesOn(db, 'p')).toHaveLength(2);
    expect(listNotesOn(db, 'p', { targetKind: 'file' })).toHaveLength(1);

    const updated = updateNoteOn(db, a.id, 'edited');
    expect(updated?.body).toBe('edited');

    deleteNoteOn(db, a.id);
    expect(listNotesOn(db, 'p')).toHaveLength(1);
  });

  it('scopes notes by project', () => {
    createNoteOn(db, { projectId: 'p1', targetKind: 'project', targetId: 'p1', body: 'a' });
    createNoteOn(db, { projectId: 'p2', targetKind: 'project', targetId: 'p2', body: 'b' });
    expect(listNotesOn(db, 'p1')).toHaveLength(1);
    expect(listNotesOn(db, 'p2')).toHaveLength(1);
  });

  it('exports notes to markdown', () => {
    createNoteOn(db, { projectId: 'p', targetKind: 'bead', targetId: 'bd-1', body: 'check this' });
    const md = exportNotesMarkdown(listNotesOn(db, 'p'));
    expect(md).toMatch(/# Review notes/);
    expect(md).toMatch(/bead: bd-1/);
    expect(md).toMatch(/check this/);
  });
});
