/**
 * Single source of truth for the bounded binary-preview read cap
 * (`WorkspaceProvider.readFileBytes`). Both transports (local `fs.stat`, remote
 * `RemoteTransport.stat`) gate on this ONE constant before reading any bytes;
 * do not duplicate or override it at a call site (a cap parameter would be a
 * bypass seam).
 *
 * Value: 10 MiB. This bounds a one-shot in-app PREVIEW payload, not a
 * transfer:
 *   - It covers virtually every repo-committed image.
 *   - It comfortably exceeds the remote helper's 2 MiB text-read cap
 *     (`remote-helper/commands.go::handleReadFile`), so a remote binary
 *     preview between 2 MiB and 10 MiB — impossible via the helper RPC — still
 *     previews correctly over this primitive's SFTP path.
 *   - Base64 inflates bytes by ~4/3, so the worst-case renderer allocation for
 *     a just-under-cap file is ~13.4 MiB — a tolerable one-off, not a steady
 *     footprint.
 *   - Anything larger uses the unbounded Download / `exportFile` escape hatch,
 *     which streams straight to disk and never crosses IPC.
 *
 * Contrast with the other read caps in this codebase (deliberately smaller —
 * this primitive answers a different question, "can this be safely handed to
 * the renderer as one IPC payload", not "is this worth reading at all"):
 *   - Local text preview: 256 KiB (`DEFAULT_MAX_BYTES`, `electron/main/git/files.ts`).
 *   - Remote helper text read: 2 MiB (`remote-helper/commands.go`).
 *
 * Precedent for a single shared constant module: `TERMINAL_SCROLLBACK` in
 * `src/shared/tmux/scrollback.ts`.
 */
export const FILE_BYTES_CAP = 10 * 1024 * 1024;
