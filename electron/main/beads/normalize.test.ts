import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_READ_MAX_BYTES } from '@shared/providers/graphReadCap';
import { loadGraph } from './normalize';
import type { BeadsSource } from './source';

/**
 * `loadGraph`'s JSONL fallback path (local_repo_explorer-jmpn): local used to
 * read `.beads/issues.jsonl` fully unbounded via `readFileSync`, while the
 * remote transport (`RemoteProvider.getTaskGraph` in
 * `electron/main/providers/remote/index.ts`) refuses a read over
 * `GRAPH_READ_MAX_BYTES` (10 MiB) with a clear error. The same project's
 * workgraph therefore loaded fine locally and hard-failed remotely, with no
 * local repro and no constant tying the two limits together. This suite pins
 * local now enforcing the SAME shared cap with the SAME refuse-never-truncate
 * behavior (never a silent truncation).
 */
describe('loadGraph (JSONL fallback) — shared size cap with remote', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-beads-normalize-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function jsonlSource(path: string): BeadsSource {
    return { kind: 'jsonl', path, schemaCompatible: true, diagnostics: [] };
  }

  it('loads a normal-sized JSONL file under the cap', () => {
    const file = join(dir, 'issues.jsonl');
    writeFileSync(
      file,
      `${JSON.stringify({
        id: 'x-1',
        title: 'T',
        status: 'open',
        priority: 2,
        issue_type: 'task',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })}\n`,
    );
    const graph = loadGraph(jsonlSource(file));
    expect(graph.issues.map((i) => i.id)).toEqual(['x-1']);
  });

  it('refuses (throws) a file over GRAPH_READ_MAX_BYTES instead of silently reading it, mirroring the remote transport', () => {
    const file = join(dir, 'issues.jsonl');
    // Content doesn't matter — the stat-based size guard must refuse BEFORE
    // any readFileSync/JSON parsing happens, so this never actually reads
    // 10+ MiB into memory as a JS string.
    writeFileSync(file, 'x'.repeat(GRAPH_READ_MAX_BYTES + 1024));
    expect(() => loadGraph(jsonlSource(file))).toThrow(/too large to read/i);
    expect(() => loadGraph(jsonlSource(file))).toThrow(/10 MiB/);
  });
});
