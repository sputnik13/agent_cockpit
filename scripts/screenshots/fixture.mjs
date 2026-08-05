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

// --- local_repo_explorer-jp2f.8 fixtures: structural JSON/YAML folding -----
//
// Proves the folding renderer (.1-.6) in the REAL launched app: JSON with a
// deeply nested region + a single-line container jsonFold.ts's
// single-line-exclusion rule must NOT treat as foldable + one deliberately
// long line for wrap/gutter-alignment testing; a three-document YAML stream;
// a YAML anchor with two aliases; and an oversized JSON file for the
// structural-fold size-threshold degrade. Exact line numbers below are
// LOAD-BEARING for verify-content-modes.mjs's fold/unfold/keyboard/gutter
// assertions (which assert exact aria-labels and exact gutter-number
// sequences) — do not reformat without updating that script's expectations.

const FOLD_JSON_BASELINE =
  [
    '{',
    '  "name": "fold-demo",',
    '  "point": { "x": 0, "y": 0 },',
    '  "list": ["alpha"]',
    '}',
  ].join('\n') + '\n';

// Line numbers (1-based) verify-content-modes.mjs depends on:
//   1  {
//   2    "name": "fold-demo",
//   3    "point": { "x": 1, "y": 2 },      <- single-line object: NOT foldable
//   4    "config": {                       <- region: header 4, closes 13, 1 item
//   5      "level1": {                     <- region: header 5, closes 12, 1 item
//   6        "level2": {                   <- region: header 6, closes 11, 1 item
//   7        "level3": {                   <- region: header 7, closes 10, 2 items (deepest)
//   8            "flag": true,
//   9            "items": [1, 2, 3]        <- single-line array: NOT foldable
//   10         }
//   11       }
//   12     }
//   13   },
//   14   "list": [                         <- region: header 14, closes 18, 3 items
//   15     "alpha",
//   16     "beta",
//   17     "gamma"
//   18   ],
//   19   "note": "<long>"                  <- deliberately overlong line
//   20 }
const FOLD_JSON_MODIFIED_LINES = [
  '{',
  '  "name": "fold-demo",',
  '  "point": { "x": 1, "y": 2 },',
  '  "config": {',
  '    "level1": {',
  '      "level2": {',
  '        "level3": {',
  '          "flag": true,',
  '          "items": [1, 2, 3]',
  '        }',
  '      }',
  '    }',
  '  },',
  '  "list": [',
  '    "alpha",',
  '    "beta",',
  '    "gamma"',
  '  ],',
  `  "note": "${'z'.repeat(320)}"`,
  '}',
];
const FOLD_JSON_MODIFIED = FOLD_JSON_MODIFIED_LINES.join('\n') + '\n';

// Three `---`-separated documents; documents 2 and 3 each carry their own
// nested foldable region so per-document grouping has real content to walk.
const YAML_MULTI_DOC =
  [
    'service: alpha',
    '---',
    'config:',
    '  timeout: 30',
    '  retries: 3',
    '---',
    'items:',
    '  - one',
    '  - two',
    '  - three',
  ].join('\n') + '\n';

// One `&defaults` anchor definition (line 1) with two `*defaults` aliases
// (lines 5 and 7).
const YAML_ANCHORS =
  [
    'defaults: &defaults',
    '  retries: 3',
    '  timeout: 30',
    'service_a:',
    '  config: *defaults',
    'service_b:',
    '  config: *defaults',
  ].join('\n') + '\n';

/**
 * Threshold (MB) verify-content-modes.mjs configures via the
 * `structuredFoldMaxMb` setting for its size-threshold degrade check —
 * pinned to that setting's own minimum (`STRUCTURED_FOLD_MAX_MB_MIN` in
 * src/shared/settings.ts) so `oversized.json` below can stay as small as the
 * degrade check allows. Exported so the harness never hardcodes a second,
 * independently-drifting copy of this number.
 */
export const OVERSIZED_JSON_THRESHOLD_MB = 1;

/**
 * Size target (MB) for a SECOND JSON fixture that stays over the RAISED read
 * cap the fix in local_repo_explorer-ftbq computes for
 * `OVERSIZED_JSON_THRESHOLD_MB` — `structuredFoldReadMaxBytes` (src/shared/
 * settings.ts) is 2x the threshold, i.e. 2 MB at the pinned minimum above.
 * `oversized.json` (~1.3 MiB, built from `OVERSIZED_JSON_THRESHOLD_MB`) now
 * falls INSIDE that raised cap and is used to verify the real degrade; this
 * fixture stays comfortably ABOVE it (4x the threshold -> ~5.2 MiB actual,
 * versus a 2 MiB cap) so the "still refuses past the raised cap" check is
 * never marginal/flaky. Exported so verify-content-modes.mjs never hardcodes
 * a second, independently-drifting copy.
 */
export const WAY_OVERSIZED_JSON_TARGET_MB = OVERSIZED_JSON_THRESHOLD_MB * 4;

/**
 * A deterministic, syntactically-valid JSON fixture comfortably larger
 * (~30% margin) than `minBytes`, built from many FIXED-LENGTH lines rather
 * than one pathologically long line — avoids both extremes (a single row
 * wide enough to strain layout, or so many rows that mounting them all is
 * slow). Content is otherwise inert (a flat padding array): this fixture
 * exists solely to exceed a byte threshold, not to exercise fold structure.
 */
function makeOversizedJson(minBytes) {
  const LINE_LEN = 300;
  const target = Math.ceil(minBytes * 1.3);
  const line = 'x'.repeat(LINE_LEN);
  const render = (items) =>
    `{\n  "marker": "oversized-fixture",\n  "pad": [\n${items
      .map((s, i) => `    "${s}"${i === items.length - 1 ? '' : ','}`)
      .join('\n')}\n  ]\n}\n`;
  const perItemBytes = LINE_LEN + 8; // '    "' + line + '",\n' — approx, self-corrected below
  const items = new Array(Math.max(1, Math.ceil(target / perItemBytes))).fill(line);
  let text = render(items);
  while (Buffer.byteLength(text, 'utf8') < target) {
    items.push(line);
    text = render(items);
  }
  return text;
}

/**
 * The exact working-tree text written for the three small structural
 * fixtures above, keyed like `CONTENT_MODE_FIXTURES` — exported so
 * verify-content-modes.mjs's byte-exact round-trip assertions compare
 * against the SAME string used to write the file, never a second,
 * hand-copied literal that could silently drift from it. `jsonOversized` and
 * `jsonWayOversized` are deliberately absent: both are inert filler content,
 * never compared byte-for-byte (see `makeOversizedJson`'s doc comment).
 */
export const FOLD_FIXTURE_TEXT = {
  jsonFold: FOLD_JSON_MODIFIED,
  yamlMultiDoc: YAML_MULTI_DOC,
  yamlAnchors: YAML_ANCHORS,
};

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
  // local_repo_explorer-jp2f.8: structural JSON/YAML folding fixtures — see
  // the FOLD_* constants above for exact content/line numbers.
  jsonFold: 'fold-demo.json',
  yamlMultiDoc: 'multi-doc.yaml',
  yamlAnchors: 'anchors.yaml',
  jsonOversized: 'oversized.json',
  // Comfortably above the raised read cap (see WAY_OVERSIZED_JSON_TARGET_MB's
  // doc comment) — local_repo_explorer-ftbq's "still refuses past the raised
  // cap" boundary case.
  jsonWayOversized: 'oversized-huge.json',
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
    // jsonFold's committed baseline (see FOLD_JSON_BASELINE's doc comment) —
    // modified below in the uncommitted-changes stage.
    'fold-demo.json': FOLD_JSON_BASELINE,
    // Committed once and NEVER modified again (like LICENSE above) — the
    // structural-fold size-threshold degrade check opens this via Explorer
    // only, so it never needs a Changes-panel diff (git diff of an unchanged
    // file is empty/cheap, unlike diffing a fresh 1MB+ added file).
    'oversized.json': makeOversizedJson(OVERSIZED_JSON_THRESHOLD_MB * 1024 * 1024),
    // Comfortably above the raised read cap — see WAY_OVERSIZED_JSON_TARGET_MB's
    // doc comment. Committed once, never modified, same rationale as
    // 'oversized.json' above.
    'oversized-huge.json': makeOversizedJson(WAY_OVERSIZED_JSON_TARGET_MB * 1024 * 1024),
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
    // jsonFold's working-tree modification (see FOLD_JSON_MODIFIED_LINES's
    // doc comment for the exact, load-bearing line numbers).
    'fold-demo.json': FOLD_JSON_MODIFIED,
    // yamlMultiDoc / yamlAnchors: brand-new files (show as added), like
    // src/search.ts above — no baseline needed for their assertions.
    'multi-doc.yaml': YAML_MULTI_DOC,
    'anchors.yaml': YAML_ANCHORS,
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
