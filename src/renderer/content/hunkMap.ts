import type { ParsedPatch, PatchHunk } from './parsePatch';

/**
 * Build a Set of line numbers (in the current/new source) that the patch's
 * additions or near-context lines fall within. Used to drive `changed` callouts
 * on rendered Markdown blocks.
 */
export function changedLinesFromPatch(patch: ParsedPatch): Set<number> {
  const set = new Set<number>();
  for (const h of patch.hunks) {
    addHunkLines(set, h);
  }
  return set;
}

function addHunkLines(set: Set<number>, h: PatchHunk): void {
  for (const ln of h.lines) {
    if (ln.kind === 'add' && ln.newLine != null) {
      set.add(ln.newLine);
    } else if (ln.kind === 'del') {
      // Map deletions to nearest surrounding context line in the new file.
      const ctx = nearestNewContext(h, ln.oldLine ?? 0);
      if (ctx != null) set.add(ctx);
    }
  }
}

function nearestNewContext(h: PatchHunk, oldLine: number): number | null {
  let best: number | null = null;
  for (const ln of h.lines) {
    if (ln.kind === 'context' && ln.oldLine != null && ln.newLine != null) {
      if (best == null || Math.abs(ln.oldLine - oldLine) < Math.abs((best ?? 0) - oldLine)) {
        best = ln.newLine;
      }
    }
  }
  return best;
}

export function mapHunksToBlocks(
  patch: ParsedPatch,
  blocks: Array<{ id: string; startLine: number; endLine: number }>,
): Map<string, PatchHunk[]> {
  const out = new Map<string, PatchHunk[]>();
  for (const h of patch.hunks) {
    const hunkNewRange = newLineRange(h);
    if (!hunkNewRange) continue;
    const block = blocks.find(
      (b) => hunkNewRange.end >= b.startLine && hunkNewRange.start <= b.endLine,
    );
    if (block) {
      const list = out.get(block.id) ?? [];
      list.push(h);
      out.set(block.id, list);
    }
  }
  return out;
}

function newLineRange(h: PatchHunk): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const ln of h.lines) {
    if (ln.newLine != null) {
      if (start == null) start = ln.newLine;
      end = ln.newLine;
    }
  }
  if (start == null || end == null) return null;
  return { start, end };
}
