// Generates a public-safe sample project for Agent Cockpit screenshots:
// a small git repo with committed history + uncommitted changes (so the Changes
// panel shows a diff) and a beads issue graph with varied states (so the
// workgraph and task detail render meaningfully).
//
// Standalone:  node scripts/screenshots/fixture.mjs   -> prints the fixture path
// Imported:    import { generateFixture } from './fixture.mjs'

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
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

/**
 * Write a set of files under the fixture dir. Each value is either a `string`
 * (written as UTF-8 text — every pre-existing caller) or a `Buffer`/`Uint8Array`
 * (written as the exact raw bytes given — `fs.writeFileSync` already accepts
 * either natively, so this is a documented, intentional capability rather than
 * an incidental one). Byte content is how the image/generic-binary corpus below
 * is produced: real bytes built in-repo via `makeSolidPng`/`makeBinaryBlob`
 * (never fetched, never a committed binary blob in this repo's own history).
 */
function writeFiles(files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(FIXTURE_DIR, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
}

// --- in-repo binary fixture generation (no network, no downloaded assets) --
//
// A minimal PNG encoder (signature + IHDR + one IDAT + IEND) and a tiny binary
// blob generator, both pure functions of their inputs so the same call always
// produces the same bytes. CRC32 is hand-rolled (not `zlib.crc32`, which is not
// available on this project's minimum supported Node — see package.json
// "engines") — verified against the standard check value ("123456789" ->
// 0xCBF43926) while developing this script.

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** A real, decodable, solid-color 8-bit RGB PNG (no palette, no interlace) —
 *  distinct `[r,g,b]` calls produce genuinely different bytes, so a
 *  before/after pair is a real content change, not a re-save of the same
 *  pixels. Verified while developing this script (`sips`/`file`) to decode as
 *  a real PNG of exactly `width`x`height`. */
function makeSolidPng(width, height, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type 2 = truecolor (RGB)
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = pngChunk('IDAT', deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/** A small, deterministic, non-image binary blob: `length` bytes cycling
 *  `[seed, seed+1, ..., seed+15]`, which always starts with a `0x00` byte (the
 *  same "contains a NUL in the first bytes" heuristic
 *  `electron/main/git/files.ts`'s `looksBinary` uses) so it is unambiguously
 *  detected as binary, never mistaken for text. Two different `seed` values
 *  produce two genuinely different (never byte-identical) blobs. */
function makeBinaryBlob(seed, length) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (seed + (i % 16)) & 0xff;
  buf[0] = 0x00;
  return buf;
}

/**
 * Repo-relative paths of the content-mode matrix corpus (markdown/JSON/source/
 * image/generic-binary, each with a committed baseline AND a working-tree
 * change — see `generateFixture` below), exported so
 * `verify-content-modes.mjs` never duplicates these as separately-maintained
 * string literals. `unchangedExplorerFile` is committed once and never
 * modified again, for the one Explorer ("unchanged file") open in that
 * harness's matrix.
 */
export const CONTENT_MODE_FIXTURES = {
  markdown: 'README.md',
  json: 'package.json',
  source: 'src/notes.ts',
  imageModified: 'assets/photo.png',
  imageAdded: 'assets/added.png',
  genericBinary: 'assets/archive.bin',
  unchangedExplorerFile: 'LICENSE',
};

export function generateFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // --- committed baseline -------------------------------------------------
  writeFiles({
    'README.md': `# Demo Notes\n\nA tiny notes library used to demo **Agent Cockpit**.\n`,
    'package.json':
      JSON.stringify(
        {
          name: 'demo-notes',
          version: '0.1.0',
          type: 'module',
          scripts: { start: 'node src/index.js' },
        },
        null,
        2,
      ) + '\n',
    'src/index.ts': `import { createNote, listNotes } from './notes';\n\ncreateNote('Welcome', 'Your first note.');\nfor (const note of listNotes()) console.log(note.title);\n`,
    'src/notes.ts': `export interface Note {\n  id: number;\n  title: string;\n  body: string;\n}\n\nconst notes: Note[] = [];\n\nexport function createNote(title: string, body: string): Note {\n  const note: Note = { id: notes.length + 1, title, body };\n  notes.push(note);\n  return note;\n}\n\nexport function listNotes(): Note[] {\n  return notes;\n}\n`,
    // Plain text, committed once and never touched again — the one file the
    // content-mode harness opens from the Explorer (unchanged, read-only view).
    LICENSE: `MIT License\n\nCopyright (c) 2026 Demo Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files, to deal in the Software\nwithout restriction, including without limitation the rights to use, copy,\nmodify, merge, publish, and distribute copies of the Software.\n`,
    // Real, decodable PNG bytes (baseline color) — see makeSolidPng's doc comment.
    'assets/photo.png': makeSolidPng(4, 4, [255, 0, 0]),
    // Real, non-image binary bytes (baseline pattern) — see makeBinaryBlob's doc comment.
    'assets/archive.bin': makeBinaryBlob(1, 96),
  });

  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.email', 'demo@example.com']);
  run('git', ['config', 'user.name', 'Demo Author']);
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', 'Initial demo notes project']);

  // --- uncommitted changes (drives the Changes panel) ---------------------
  writeFiles({
    // modify an existing file: add a search helper + a tags field, plus one
    // deliberately overlong line for verify-content-modes.mjs's gutter-
    // alignment regression check (Rendered/Raw x Wrap off/on). It is always
    // the LAST line of this file — that harness locates it by counting
    // rendered line-number gutters rather than hardcoding a line number.
    'src/notes.ts': `export interface Note {\n  id: number;\n  title: string;\n  body: string;\n  tags: string[];\n}\n\nconst notes: Note[] = [];\n\nexport function createNote(title: string, body: string, tags: string[] = []): Note {\n  const note: Note = { id: notes.length + 1, title, body, tags };\n  notes.push(note);\n  return note;\n}\n\nexport function listNotes(): Note[] {\n  return notes;\n}\n\nexport function searchNotes(query: string): Note[] {\n  const q = query.toLowerCase();\n  return notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));\n}\n\n// Intentionally long line (gutter-alignment regression check fixture):\nexport const OVERFLOW_MARKER = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';\n`,
    // brand-new file (shows as added)
    'src/search.ts': `import { searchNotes } from './notes';\n\nexport function runSearch(query: string): void {\n  const hits = searchNotes(query);\n  console.log(\`\${hits.length} match(es) for "\${query}"\`);\n}\n`,
    // tweak the README (shows as modified): reword the intro line (a real
    // del+add pair, not just an appended section) AND add a features list, so
    // the Diff cell has both removed and added rows.
    'README.md': `# Demo Notes\n\nA tiny notes library used to demo **Agent Cockpit**, with tags and search.\n\n## Features\n\n- Create notes\n- Tag notes\n- Full-text search (in progress)\n`,
    // tweak package.json (shows as modified; gives the JSON matrix cell a real diff)
    'package.json':
      JSON.stringify(
        {
          name: 'demo-notes',
          version: '0.2.0',
          type: 'module',
          description: 'A tiny notes library with tags and full-text search.',
          scripts: { start: 'node src/index.js' },
        },
        null,
        2,
      ) + '\n',
    // MODIFIED image: same path, genuinely different pixel bytes than the
    // committed baseline (blue vs. the baseline's red) — a real content change,
    // not a re-save of identical pixels.
    'assets/photo.png': makeSolidPng(4, 4, [0, 0, 255]),
    // ADDED-only image: no baseline at all (untracked).
    'assets/added.png': makeSolidPng(4, 4, [0, 255, 0]),
    // MODIFIED generic binary: same path, genuinely different bytes.
    'assets/archive.bin': makeBinaryBlob(97, 96),
  });

  // --- beads issue graph (varied states for the workgraph) ----------------
  run('br', ['init']);
  const epic = bead([
    'create',
    'Build the demo notes app',
    '-t',
    'epic',
    '-p',
    '1',
    '-d',
    'Umbrella for the demo notes feature work: model, search, tags, persistence.',
  ]);
  const model = bead([
    'create',
    'Define the Note model',
    '-t',
    'task',
    '-p',
    '2',
    '-d',
    'Introduce the Note interface (id/title/body) and the in-memory store.',
  ]);
  const search = bead([
    'create',
    'Add full-text search',
    '-t',
    'task',
    '-p',
    '1',
    '-d',
    'Add searchNotes(query) over title + body, case-insensitive. Wire a small CLI entry in src/search.ts.',
  ]);
  const tags = bead([
    'create',
    'Add tags to notes',
    '-t',
    'task',
    '-p',
    '2',
    '-d',
    'Extend Note with a tags[] field and allow createNote(title, body, tags).',
  ]);
  const persist = bead([
    'create',
    'Persist notes to disk',
    '-t',
    'task',
    '-p',
    '3',
    '-d',
    'Serialize the note store to a JSON file and reload it on startup. Depends on search landing first.',
  ]);

  // hierarchy: all tasks under the epic
  for (const t of [model, search, tags, persist])
    run('br', ['dep', 'add', t, epic, '--type', 'parent-child', '-q']);
  // ordering: tags follows the model; persistence waits on search
  run('br', ['dep', 'add', tags, model, '-q']);
  run('br', ['dep', 'add', persist, search, '-q']);

  // states: model done, search active (with a comment), persist explicitly blocked
  run('br', ['close', model, '-q']);
  run('br', ['update', search, '--status', 'in_progress', '-q']);
  run('br', [
    'comments',
    'add',
    search,
    'Tokenizing on whitespace for now; ranking comes later.',
    '-q',
  ]);
  run('br', ['update', persist, '--status', 'blocked', '-q']);

  run('br', ['sync', '--flush-only', '-q']);

  return FIXTURE_DIR;
}

// Run directly: generate and print the path for the capture harness / manual use.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(generateFixture() + '\n');
}
