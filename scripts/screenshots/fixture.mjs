// Generates a public-safe sample project for Agent Cockpit screenshots:
// a small git repo with committed history + uncommitted changes (so the Changes
// panel shows a diff) and a beads issue graph with varied states (so the
// workgraph and task detail render meaningfully).
//
// Standalone:  node scripts/screenshots/fixture.mjs   -> prints the fixture path
// Imported:    import { generateFixture } from './fixture.mjs'

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_DIR = join(tmpdir(), 'agent-cockpit-demo');

/** Run a command in the fixture dir, returning trimmed stdout. */
function run(cmd, args, cwd = FIXTURE_DIR) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

/** Create a bead and return its id (parsed from `✓ Created <id>: ...`). */
function bead(args) {
  const out = run('br', args);
  const m = out.match(/Created\s+(\S+):/);
  if (!m) throw new Error(`could not parse bead id from: ${out}`);
  return m[1];
}

function writeFiles(files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(FIXTURE_DIR, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
}

export function generateFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // --- committed baseline -------------------------------------------------
  writeFiles({
    'README.md': `# Demo Notes\n\nA tiny notes library used to demo **Agent Cockpit**.\n`,
    'package.json':
      JSON.stringify(
        { name: 'demo-notes', version: '0.1.0', type: 'module', scripts: { start: 'node src/index.js' } },
        null,
        2,
      ) + '\n',
    'src/index.ts': `import { createNote, listNotes } from './notes';\n\ncreateNote('Welcome', 'Your first note.');\nfor (const note of listNotes()) console.log(note.title);\n`,
    'src/notes.ts': `export interface Note {\n  id: number;\n  title: string;\n  body: string;\n}\n\nconst notes: Note[] = [];\n\nexport function createNote(title: string, body: string): Note {\n  const note: Note = { id: notes.length + 1, title, body };\n  notes.push(note);\n  return note;\n}\n\nexport function listNotes(): Note[] {\n  return notes;\n}\n`,
  });

  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 'demo@example.com']);
  run('git', ['config', 'user.name', 'Demo Author']);
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', 'Initial demo notes project']);

  // --- uncommitted changes (drives the Changes panel) ---------------------
  writeFiles({
    // modify an existing file: add a search helper + a tags field
    'src/notes.ts': `export interface Note {\n  id: number;\n  title: string;\n  body: string;\n  tags: string[];\n}\n\nconst notes: Note[] = [];\n\nexport function createNote(title: string, body: string, tags: string[] = []): Note {\n  const note: Note = { id: notes.length + 1, title, body, tags };\n  notes.push(note);\n  return note;\n}\n\nexport function listNotes(): Note[] {\n  return notes;\n}\n\nexport function searchNotes(query: string): Note[] {\n  const q = query.toLowerCase();\n  return notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));\n}\n`,
    // brand-new file (shows as added)
    'src/search.ts': `import { searchNotes } from './notes';\n\nexport function runSearch(query: string): void {\n  const hits = searchNotes(query);\n  console.log(\`\${hits.length} match(es) for "\${query}"\`);\n}\n`,
    // tweak the README (shows as modified)
    'README.md': `# Demo Notes\n\nA tiny notes library used to demo **Agent Cockpit**.\n\n## Features\n\n- Create notes\n- Tag notes\n- Full-text search (in progress)\n`,
  });

  // --- beads issue graph (varied states for the workgraph) ----------------
  run('br', ['init']);
  const epic = bead(['create', 'Build the demo notes app', '-t', 'epic', '-p', '1',
    '-d', 'Umbrella for the demo notes feature work: model, search, tags, persistence.']);
  const model = bead(['create', 'Define the Note model', '-t', 'task', '-p', '2',
    '-d', 'Introduce the Note interface (id/title/body) and the in-memory store.']);
  const search = bead(['create', 'Add full-text search', '-t', 'task', '-p', '1',
    '-d', 'Add searchNotes(query) over title + body, case-insensitive. Wire a small CLI entry in src/search.ts.']);
  const tags = bead(['create', 'Add tags to notes', '-t', 'task', '-p', '2',
    '-d', 'Extend Note with a tags[] field and allow createNote(title, body, tags).']);
  const persist = bead(['create', 'Persist notes to disk', '-t', 'task', '-p', '3',
    '-d', 'Serialize the note store to a JSON file and reload it on startup. Depends on search landing first.']);

  // hierarchy: all tasks under the epic
  for (const t of [model, search, tags, persist]) run('br', ['dep', 'add', t, epic, '--type', 'parent-child', '-q']);
  // ordering: tags follows the model; persistence waits on search
  run('br', ['dep', 'add', tags, model, '-q']);
  run('br', ['dep', 'add', persist, search, '-q']);

  // states: model done, search active (with a comment), persist explicitly blocked
  run('br', ['close', model, '-q']);
  run('br', ['update', search, '--status', 'in_progress', '-q']);
  run('br', ['comments', 'add', search, 'Tokenizing on whitespace for now; ranking comes later.', '-q']);
  run('br', ['update', persist, '--status', 'blocked', '-q']);

  run('br', ['sync', '--flush-only', '-q']);

  return FIXTURE_DIR;
}

// Run directly: generate and print the path for the capture harness / manual use.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(generateFixture() + '\n');
}
