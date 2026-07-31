<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=test_plan -->

# Test Plan

## Strategy

Unit-first for transport-agnostic logic (the provider contract, patch/hunk
mapping, the helper protocol codec, the session state machine), integration
tests for the `LocalProvider` against a temp git repo, Go tests for the remote
helper, and jsdom render tests for renderer panels and primitives. Live remote
integration (real ssh2 against a loopback host, helper upload, tmux
attach/reattach) is deferred; the remote codec and result-mapping logic are
covered by unit tests that exercise `RemoteProvider`/`HelperRpcClient` over an
in-memory stream instead. Renderer tests use a fake `WorkspaceProvider` so
panels never touch a real transport.

## Unit Scope

- `parsePatch` round-trips unified diffs (hunk count, line classification, line
  numbers); `hunkMap` / changed-block mapping returns the expected new-line set
  for a fixture patch.
- `HelperRpcClient` JSON-RPC framing/codec: request/response correlation by id,
  server-push `watch` event dispatch, and handshake/protocol-version handling
  over an in-memory `PassThrough` pair (no live SSH or built binary).
- `SessionManager` state transitions: open, activate (only `activeId` moves — no
  suspend of other live sessions), close, closeAll, and active-id persistence;
  per-session watch lifecycle (one sub per live session; stopped on
  disconnect/failed AND eviction; `watchSubCount` exposed as a test seam);
  failed-connect eviction (no dead provider cached → reconnect retries);
  disconnect keeps the project selected; reconnect evicts + rebuilds a fresh
  provider; status forwarding is wired before connect (the first `connected`
  transition is delivered, not
  dropped); eviction listeners fire so IPC caches are disposed.
- `ConnectionMachine`: every legal transition succeeds and every illegal one is
  rejected (no-op + warn, never thrown); concurrent `connecting`/`reconnecting`
  requests coalesce to the in-flight transition; `shortCircuitConnected` for
  local; subscribers receive the full sequence including `connecting`/
  `reconnecting`.
- `RemoteProvider` result mapping: `mapGitStatus` porcelain/name-status codes,
  `assembleChangeset`, and `parseBeadsJsonl` against fixture inputs.
- Renderer beads graph selectors/layout and content-mode selection.
- tmux control-mode shared protocol
  ([src/shared/tmux/parser.test.ts](../src/shared/tmux/parser.test.ts),
  [codec.test.ts](../src/shared/tmux/codec.test.ts),
  [layout.test.ts](../src/shared/tmux/layout.test.ts)): framing,
  `%begin`/`%end`/`%error` reply correlation, `%output` octal decode (including
  raw-byte preservation through the `Uint8Array` path), notification typing,
  and window-layout-string → tree parsing for single/h-split/v-split/nested
  layouts. Pure; no tmux required.
- Renderer control-mode reducer/UI
  ([src/renderer/tmux/tmuxStore.test.ts](../src/renderer/tmux/tmuxStore.test.ts),
  [controlTerminal.test.tsx](../src/renderer/tmux/controlTerminal.test.tsx),
  [extractScreenTitle.test.ts](../src/renderer/tmux/extractScreenTitle.test.ts)):
  notification sequences reduce into the correct per-project windows/panes/
  layout state, pane output writes to the bound xterm, input emits the right
  `tmuxControl:input` hex command, and SCREEN-style title sequences extract
  cleanly across chunk boundaries.
- Renderer live-refresh orchestration (`panelDataSync`): a per-session
  `connected` status loads that project's Changes + Workgraph slices; a
  `projectId`-tagged watch event refreshes the addressed project's slice
  (`.beads/*` → reload the graph; `.git/HEAD`/`refs` → reload worktrees; other
  working-tree paths → refresh the changeset only) and is a no-op for unrelated
  paths; `disconnected`/`failed` clears the slice (`clearForDisconnect`) and a
  removed project evicts it (`evict`). Load/refresh always target the read's
  `projectId`, never `activeId`.
- Renderer per-project store slices (`changesStore`/`beadsStore` `byProject`):
  load/refresh/clear/evict isolate per project; the active selector returns only
  `byProject[activeId]` (no cross-project bleed at any frame); per-slice
  selection/view memory is retained.
- **Watch policy** (`src/shared/watch/policy.ts`): `classifyWatchPath`
  category mapping — working-tree / git-state / beads / excluded (null);
  `-wal`/`-shm`/`.lock` → excluded; `isHiddenFromChanges` with and without
  `showAll`; `deriveWatchSpec` shape includes expected interest paths and
  `DIRECTORY_GRANULARITY` entries.
- **Ingest pipeline** (`electron/main/watch/ingest.ts`): debounce/coalesce
  with the single `WATCH_DEBOUNCE_MS`; path normalization to repo-relative
  POSIX; category aggregation across batched events; WAL echo suppression
  (`.beads/beads.db-wal` and `.beads/beads.db-shm` paths produce no output).
- **Renderer dispatch hub** (`src/renderer/watch/hub.ts`): events routed only
  to matching-interest subscribers; subscribers with no matching category
  receive nothing; unsubscribe correctly stops delivery; the `projectId` tag is
  carried on the event so `panelDataSync` can route by `(projectId, category)`.
- **Session idle reaper** (`electron/main/providers/sessionReaper.ts`):
  `sweepIdleSessions` (injected clock + fake `SessionManager`) selects only
  stale, non-active, settled **remote** sessions; never reaps the active session,
  a local session, or a `connecting`/`reconnecting` one; re-checks
  `activeProjectId()` immediately before `close()`; respects the
  `sessionIdleTimeoutMin = 0` off switch; isolates a per-session `close()` error
  and continues; reads status from `statusOf` (the machine), never a renderer
  enum. `normalizeSettings` clamps `sessionIdleTimeoutMin` (default 20, `0` =
  disabled, negatives/non-numbers → default, upper bound).
- **Reserved-window reconcile** (`reconcile` in
  `src/renderer/tmux/controlSession.ts`): clean session → no-op; missing reserved
  → create; duplicates → kill extras keep the lowest-id of each class; survivor
  `run-N` renamed to `run-1`; empty `list-windows` → `{bail:true}` (no create, no
  init); all-hidden → create first terminal; single-flight acquire shares one
  ensure promise and a bail does not consume the init guard. Pure, no I/O.
- **Remote transport conformance** (`Ssh2Transport`, ssh2 stubbed via the
  `createClient()` seam): `connect` builds the expected config for privateKey and
  agent fallback and errors when neither is available; the `hostVerifier` rejects
  a mismatched key with `phase:'hostkey'`; `exec` captures stdout/stderr
  separately, returns `code` (`null` on signal), never rejects on non-zero,
  rejects when not connected; `openPty`/`openShell`/`execStream` deliver raw bytes
  (a `>0x7E` powerline fixture arrives unmodified); the factory returns
  `Ssh2Transport`. ESLint `no-restricted-imports` bans `ssh2` outside the impl.
- **Control-mode scrollback single-source** (`src/shared/tmux`):
  `capturePane(id, { startLine: TERMINAL_SCROLLBACK })` emits `-S -N` and an
  omitted `startLine` preserves the no-`-S` form; the local opener sets `-g
  history-limit` to `TERMINAL_SCROLLBACK` before `new-session`.
- **Changes surface filter**: `isHiddenFromChanges` hides `.git/**` and
  `.beads/**` when `showAll = false`; reveals them when `showAll = true`;
  non-hidden working-tree paths pass through in both modes.
- Rendered Markdown (single-pass unified pipeline + DOMPurify): a corpus
  fixture exercises headings, nested/ordered/task lists, tables, blockquote,
  hr, strikethrough, inline/fenced/indented code, autolinks, reference links,
  footnotes, images, and inline HTML. Assertions cover construct presence,
  cross-block reference-link resolution, top-level `data-start-line`/
  `data-end-line` annotation, changed-block callout matching against
  `changedLineSet`, `rehype-highlight` token emission, sanitization
  (no `script` survives; no `javascript:` href; no inline event handlers),
  and the safe-link/image transform (`target`/`rel`/`data-external` on
  absolute anchors, `data-inert` on relative/fragment, blocked image src
  collapses to alt-text span).

- **Terminal & Workgraph feature batch**: the `tmuxStore` reducer records
  `isZoomed`/`visibleLayout` from a zoomed `%layout-change` and clears them on an
  unzoomed one; `normalizeSettings` defaults/coerces `byobuKeybindings`;
  `withNativeArch` returns the `arch -arm64` prefix only when translated **and** the
  probe succeeds (identity otherwise; memoized); `focusedSubgraph(Infinity)`,
  `ancestorsOf` (root-first, cycle-safe), and `findTreeNode` for tree focus; the
  beads `runner` argv builders (P0 not dropped; shell-looking title stays an inert
  literal) + `parseComments`/`parseCreatedId`/`beadsErrorMessage`; the `beadsStore`
  write actions (success reloads the graph, failure returns `br`'s message stripped
  of IPC noise); `PanelHeader` renders the maximize control only inside a host and
  toggles via context; `TaskDetail` strikes a completed blocked-by item and a
  related-bead click re-points the shared selection.
- **Control-mode renderer (`PaneRenderer`)**: `createPaneRenderer` selects the
  xterm adapter for `dom`/`webgl` and the wterm adapter for `wterm` (both adapters
  mocked); the `XtermPaneRenderer` reproduces the prior behavior (its
  `repaintFromBuffer` clears the atlas + refreshes; `write` forwards a `Uint8Array`
  verbatim); the `WtermPaneRenderer` forwards `write(Uint8Array)` verbatim, buffers
  writes/onData/focus until `init()` resolves and flushes them in order, and maps
  `XTERM_THEMES` onto wterm CSS variables; `normalizeSettings` accepts the `wterm`
  `terminalRenderer` value (default `dom`). DOM glyph fidelity (powerline) is a
  runtime check.
- Bounded file export (Download): `writeStreamToDest` temp-then-rename
  semantics (success renames into place; any failure unlinks the temp and
  leaves the destination untouched) in `exportWrite.test.ts`; `localExportFile`
  byte-identity for text, binary, and over-preview-cap files plus
  linked-worktree base resolution in `local.test.ts`;
  `Ssh2Transport.stat`/`createReadStream` over a stubbed SFTP surface
  (whole-file read, `{start, end}` ranged read, error propagation on the
  returned `Readable`, per-call SFTP channel release) in
  `transport.conformance.test.ts`, exercised through the `RemoteTransport`
  interface via `createRemoteTransport()` in `remote.test.ts`; the shared
  row-menu substrate (path resolution including the remote and root-browse
  shapes, disabled states, clipboard/download actions, transient feedback) in
  `rowMenu.test.tsx`, with panel wiring in `changes.test.tsx` /
  `explorer.test.tsx`.

## Integration Scope

- **Beads write surface** ([beadsWrite.test.ts](../electron/main/providers/local/beadsWrite.test.ts),
  gated on `br`): `br init` a temp repo, then drive `LocalProvider` through
  create-child → comment → list-comments → close → reopen, asserting the graph
  read-back reflects each mutation and that an invalid op rejects with `br`'s
  message. The remote path reuses the same argv builders over the helper
  `beadsExec` RPC (`remote-helper/commands_test.go::TestBeadsExec`).
- `LocalProvider` against a temp git repo: `listWorktrees`, `getChangeset`,
  `getFileDiff`, `readFile`/`stat`, beads read against a fixture `.beads`, and
  debounced chokidar watch events. node-pty terminal is exercised where the
  native binding loads (skipped under an incompatible ABI runtime).
- App-local SQLite stores (`projects`, `notes`) against a real database,
  including project reorder (`sort_order`) and the Run-panel command
  (`run_command`) round-trip (set / read / clear).
- Remote live integration (ssh2 against loopback/container: helper
  upload+launch, RPC round-trips, tmux attach → write → reattach with
  scrollback, simulated disconnect/reconnect) is specified here but deferred;
  it is the resilience gate when enabled.
- **Go helper watch integration** (`remote-helper/watch_test.go`): helper
  consumes pushed `WatchSpec`; emits events for paths matching spec signal
  paths (`.beads/issues.jsonl`, `.git/HEAD`, `.git/refs/**`); prunes
  `node_modules` + gitignored trees; regression: `.beads/issues.jsonl` and
  `.git/HEAD`/`.git/refs/**` now produce events (the remote auto-refresh bug).
- **Watch transport parity**: local and remote yield the same canonical
  `categories` for the same logical change (write `.beads/issues.jsonl` →
  both transports produce `WatchCategory: 'beads'` in the ingest output).
- Host tmux control-mode (`-CC`) integration
  ([electron/main/providers/local/tmuxControl.test.ts](../electron/main/providers/local/tmuxControl.test.ts)):
  spawns `tmux -CC` on the cockpit socket and asserts that window/pane
  create/split/kill/resize commands produce the expected notifications and
  pane ids, that `send-keys -H` round-trips input, that `capture-pane` seeds
  scrollback, and that the control client can detach/reattach and rebuild
  state. Gated when `tmux` is absent. The remote control-mode transport is
  covered by [providers/remote/tmuxControl.test.ts](../electron/main/providers/remote/tmuxControl.test.ts)
  using a fake channel (no live SSH): reconnect/backoff and notification
  resync.

## E2E Scope

- App boots to a styled shell (no white flash); add a local project; terminal
  accepts input; edit a file via the terminal; the changes list + content
  viewer update; switching to an already-connected project shows its current data
  immediately (no spinner) and never another project's data. The automated E2E
  harness is not yet wired; this flow is currently a manual smoke.

## Test Data

- A fixture git repo with mixed change types and a Markdown file containing a
  Mermaid block; a fixture `.beads` graph (SQLite and/or `issues.jsonl`); a
  throwaway SSH target (loopback/container) for the deferred remote suite.

## Mocking

- A fake `WorkspaceProvider` backs renderer/panel/primitive tests.
- The helper RPC codec is tested over an in-memory duplex stream rather than a
  mocked SSH server; when the live remote suite is enabled it uses real ssh2
  against loopback (no mocked SSH) and real node-pty in local integration.

## Coverage Goals

- The provider contract surface, `SessionManager`, and the helper protocol
  codec are unit-covered.
- `LocalProvider` integration against a temp git repo passes wherever the
  native ABI matches.
- One green remote reconnect integration test is the resilience gate once the
  deferred live remote suite is enabled.

### Known Constraint: better-sqlite3 ABI

`better-sqlite3` is a native module compiled for Electron's ABI in this repo
(via electron-rebuild). It cannot load under the plain-Node vitest runner, so
DB-touching suites (`store/projects.test.ts`, `store/notes.test.ts`) guard with
a `dbUsable()` check and `describe.skip` when the binding fails to load. They
run only where the ABI matches — a CI Node build of the binding or an
Electron-context test runner. node-pty has the same constraint in
`LocalProvider` integration and is skipped when its native binding is
unavailable. Go helper tests (`protocol_test.go`, `commands_test.go`,
`watch_test.go`) run under `go test` independently of the Node/Electron runner.

### Quality Gates

- `npm run typecheck` (project references for main + renderer).
- `npm run lint` (ESLint flat config + TS + React + hooks).
- `npm run test` (vitest; remote-helper excluded — covered by `go test`).
- `go test ./...` in `remote-helper/`.
- `npm run build` produces a runnable Electron artifact.

## Acceptance Tests

These map 1:1 to the Requirements acceptance criteria:

- Add a local and a remote project, switch between them, each shows its own
  terminal/beads/changeset (FR-1, FR-2, FR-6, FR-7).
- Kill the SSH link mid-agent-run and reconnect to the same tmux session with
  the agent running and scrollback preserved (FR-4, FR-5, NFR-4).
- Edit a file via the terminal; the active project's changes list + content
  viewer update and an inactive project's views do not (FR-3, FR-8, NFR-5).
- On a remote project: a `br` flush, a commit, and a branch switch each
  auto-refresh the Changes panel and the workgraph panel without a manual
  refresh (FR-8 remote transport parity — the remote auto-refresh regression).
- The Changes list hides `.beads` entries by default; enabling "show all
  changes" reveals them and toggling updates live (FR-8 surface policy).
- The remote helper uploads and launches automatically on first connect with no
  host-side install beyond tmux (NFR-3).
- Set a project run command, press Run, and see it execute in the Run-panel tty
  (`agent-cockpit-run-<projectId>`); Stop interrupts it; the command persists
  across restart (FR-11). Currently a manual smoke pending the E2E harness.
- Renderer surfaces are styled through shared roles/components, not per-element
  inline styles.

## Linked Documents

- [docs/REQUIREMENTS.md](REQUIREMENTS.md) — acceptance criteria the tests map
  to.
- [docs/DESIGN.md](DESIGN.md) — the components under test.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — boundaries the security checks
  enforce.
