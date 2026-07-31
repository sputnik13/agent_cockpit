export interface PatchHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface PatchLine {
  kind: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ParsedPatch {
  file: { from: string | null; to: string | null };
  hunks: PatchHunk[];
  meta: string[];
  /**
   * True when the patch is git's binary-diff summary ("Binary files a/… and
   * b/… differ") rather than a line-by-line unified diff — i.e. git detected
   * a change but never attempted (and could not produce) hunks for it. Never
   * true together with a non-empty `hunks`: git emits one or the other for a
   * given file, never both. Only set when git actually reports a change — an
   * unmodified file's diff is empty and carries no such line, so `binary`
   * stays `false` for a genuinely-unchanged binary file (there is no signal
   * to distinguish that case from an unchanged text file without a new
   * read). See DiffView.tsx, which renders the generic-binary placeholder
   * when this is `true` instead of its plain empty-diff hint.
   */
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const BINARY_DIFFER_RE = /^Binary files .* differ$/;

export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split('\n');
  const meta: string[] = [];
  let from: string | null = null;
  let to: string | null = null;
  let binary = false;
  const hunks: PatchHunk[] = [];

  let current: PatchHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const raw of lines) {
    if (raw.startsWith('--- ')) {
      from = raw.slice(4).replace(/^a\//, '').trim() || null;
      meta.push(raw);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      to = raw.slice(4).replace(/^b\//, '').trim() || null;
      meta.push(raw);
      continue;
    }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity index') || raw.startsWith('rename ')) {
      meta.push(raw);
      continue;
    }
    if (BINARY_DIFFER_RE.test(raw)) {
      // git's binary-diff summary line — no hunks will ever follow for this
      // file. Intercepted here (rather than falling through to the
      // `if (!current) continue;` below, which would silently drop it) so
      // DiffView can detect it.
      meta.push(raw);
      binary = true;
      continue;
    }
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      current = {
        header: raw,
        oldStart: Number(hm[1]),
        oldCount: hm[2] ? Number(hm[2]) : 1,
        newStart: Number(hm[3]),
        newCount: hm[4] ? Number(hm[4]) : 1,
        lines: [],
      };
      oldNum = current.oldStart;
      newNum = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\ ')) {
      current.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newNum });
      newNum += 1;
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldNum, newLine: null });
      oldNum += 1;
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldNum, newLine: newNum });
      oldNum += 1;
      newNum += 1;
    }
  }
  return { file: { from, to }, hunks, meta, binary };
}

export function hunkId(h: PatchHunk): string {
  return `${h.oldStart}:${h.oldCount}->${h.newStart}:${h.newCount}`;
}
