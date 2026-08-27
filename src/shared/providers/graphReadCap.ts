/**
 * Single source of truth for the `.beads/issues.jsonl` workgraph read cap.
 * Both transports gate on this ONE constant before parsing the file into a
 * `BeadsTaskGraph`:
 *   - local: a stat-then-refuse guard in `electron/main/beads/normalize.ts`
 *     before `readFileSync`;
 *   - remote: a `maxBytes` override on the helper's `readFile` RPC
 *     (`electron/main/providers/remote/index.ts`), which refuses (never
 *     truncates) a file over the effective cap.
 * so a project's workgraph behaves identically regardless of which transport
 * loads it, instead of loading unbounded locally while hard-refusing remotely
 * at a different, unrelated threshold (the asymmetry local_repo_explorer-jmpn
 * fixed — the exact same project's workgraph used to load fine locally and
 * hard-fail remotely once the file crossed 10 MiB).
 *
 * Value: 10 MiB. `.beads/issues.jsonl` is full task history (including
 * tombstones), not a preview, and routinely outgrows a few hundred KB on
 * active projects. 10 MiB sits well under the remote helper's own 12 MiB
 * frame-size ceiling (`maxReadFileCapBytes`, which clamps a caller-requested
 * override rather than honoring it verbatim), leaving headroom.
 *
 * Both transports REFUSE (throw a clear, actionable error) rather than
 * silently truncate when the file exceeds this cap — a truncated JSONL parse
 * would silently render as an empty-but-valid "no tasks" graph with no
 * indication anything is wrong (see `toTaskGraph`'s doc comment in
 * `electron/main/providers/remote/index.ts`).
 *
 * Precedent for a single shared constant module: `FILE_BYTES_CAP` in
 * `./fileBytesCap.ts`, `TERMINAL_SCROLLBACK` in `src/shared/tmux/scrollback.ts`.
 */
export const GRAPH_READ_MAX_BYTES = 10 * 1024 * 1024;
