/**
 * App-local review notes + review-pass marker. Notes attach to a
 * project/worktree/file/hunk/block/bead target and export to Markdown for
 * handoff. All app-local; never writes to the repository.
 */
import type Database from 'better-sqlite3';
import type { NoteRecord, ReviewTargetKind } from '@shared/ipc/channels';
import { getDb } from './sqlite';

interface NoteRow {
  id: number;
  project_id: string;
  target_kind: string;
  target_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** 1-based anchored line (null for project/file-level notes). */
  line: number | null;
  /** Snapshot of the anchored line's text at capture (null otherwise). */
  anchor_text: string | null;
}

function toRecord(r: NoteRow): NoteRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    targetKind: r.target_kind as ReviewTargetKind,
    targetId: r.target_id,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    line: r.line,
    anchorText: r.anchor_text,
  };
}

export interface CreateNoteInput {
  projectId: string;
  targetKind: ReviewTargetKind;
  targetId: string;
  body: string;
  /** 1-based anchored line for a line note; omit for project/file-level notes. */
  line?: number | null;
  /** Snapshot of the anchored line's text for outdated detection. */
  anchorText?: string | null;
}

export function createNoteOn(db: Database.Database, input: CreateNoteInput): NoteRecord {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO agent_cockpit_notes
         (project_id, target_kind, target_id, body, created_at, updated_at, line, anchor_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.projectId,
      input.targetKind,
      input.targetId,
      input.body,
      now,
      now,
      input.line ?? null,
      input.anchorText ?? null,
    );
  return getNoteOn(db, Number(info.lastInsertRowid))!;
}

export function getNoteOn(db: Database.Database, id: number): NoteRecord | null {
  const row = db.prepare(`SELECT * FROM agent_cockpit_notes WHERE id = ?`).get(id) as NoteRow | undefined;
  return row ? toRecord(row) : null;
}

export function updateNoteOn(db: Database.Database, id: number, body: string): NoteRecord | null {
  db.prepare(`UPDATE agent_cockpit_notes SET body = ?, updated_at = ? WHERE id = ?`).run(
    body,
    new Date().toISOString(),
    id,
  );
  return getNoteOn(db, id);
}

export function deleteNoteOn(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM agent_cockpit_notes WHERE id = ?`).run(id);
}

export function listNotesOn(
  db: Database.Database,
  projectId: string,
  filter?: { targetKind?: ReviewTargetKind; targetId?: string },
): NoteRecord[] {
  const clauses = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (filter?.targetKind) {
    clauses.push('target_kind = ?');
    params.push(filter.targetKind);
  }
  if (filter?.targetId) {
    clauses.push('target_id = ?');
    params.push(filter.targetId);
  }
  const rows = db
    .prepare(`SELECT * FROM agent_cockpit_notes WHERE ${clauses.join(' AND ')} ORDER BY created_at`)
    .all(...params) as NoteRow[];
  return rows.map(toRecord);
}

export function exportNotesMarkdown(notes: NoteRecord[]): string {
  if (notes.length === 0) return '# Review notes\n\n_(none)_\n';
  const lines = ['# Review notes', ''];
  for (const n of notes) {
    // Line notes get a `path:line` heading so the handoff Markdown points at the
    // exact spot; project/file-level notes (no line) keep the bare target.
    const target = n.line != null ? `${n.targetId}:${n.line}` : n.targetId;
    lines.push(`## ${n.targetKind}: ${target}`, '', n.body, '', `_— ${n.updatedAt}_`, '');
  }
  return lines.join('\n');
}

// Thin wrappers over the live app DB.
export const createNote = (i: CreateNoteInput): NoteRecord => createNoteOn(getDb(), i);
export const updateNote = (id: number, body: string): NoteRecord | null =>
  updateNoteOn(getDb(), id, body);
export const deleteNote = (id: number): void => deleteNoteOn(getDb(), id);
export const listNotes = (
  projectId: string,
  filter?: { targetKind?: ReviewTargetKind; targetId?: string },
): NoteRecord[] => listNotesOn(getDb(), projectId, filter);
