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
- Persisted-profile continuity: `electron/main/config.test.ts` loads a populated
  prior profile and asserts the saved terminal backend, renderer, font size,
  config bytes, and profile marker remain unchanged; the Electron-ABI
  `electron/main/store/projects.test.ts` migration fixture verifies existing
  local/remote project IDs, connection data, and ordering survive later schema
  migrations. `scripts/test-dev-supervisor.mjs` protects normal development's
  historical profile identity and absence of a `userData` override while
  keeping packaged identity and explicit isolated launches distinct.
- macOS dev-launcher lifecycle: `scripts/test-dev-supervisor.mjs` verifies the
  generated launcher is a background-only Dock agent, normal dev keeps the
  historical profile and persistent resources, isolated dev cleans only its
  unique resources, and a simulated Electron-main exit reaps the Vite process
  group and supervisor.
- tmux control-mode shared protocol
  ([src/shared/tmux/parser.test.ts](../src/shared/tmux/parser.test.ts),
  [codec.test.ts](../src/shared/tmux/codec.test.ts),
  [layout.test.ts](../src/shared/tmux/layout.test.ts)): framing,
  `%begin`/`%end`/`%error` reply correlation, `%output` octal decode (including
  raw-byte preservation through the `Uint8Array` path), notification typing,
  and window-layout-string → tree parsing for single/h-split/v-split/nested
  layouts. Pure; no tmux required.
- Local PTY process ownership: production daemon launch omits the owner pipe and
  survives Electron quit; `COCKPIT_MUX_EPHEMERAL=1` opts isolated tests/dev into
  owner-pipe EOF shutdown. Owned-pane tests prove natural shell exit cleans
  same-session helpers before `cmd.Wait()` reaps the leader, pinning its SID
  during enumeration. Handoff transfers the original leader identity; the
  adopter seeds member identities before ACK, then begins lifecycle mutation
  only after ACK. After leader exit, adopted cleanup is fail-closed and signals
  only recorded identities that still match. A direct launcher test verifies
  `stopLocalMuxOwners()` leaves a production daemon serving `session.list` but
  releases an ephemeral daemon. The packaged Playwright topology test covers
  app quit/relaunch; the dedicated SIGKILL test verifies owner-pipe cleanup.
  The adopted-pane race for a helper created after the last sample is
  documented in [the process-lifecycle record](operations/process-lifecycle.md).
- Mux lifecycle serialization: race natural pane exit against `Operations.Close()`;
  attachment `Finalize()` and `Close()` must not overlap or run on an already
  closed attachment. Multi-pane logical-session shutdown finalizes every pane
  before reaping the shared catalog rows, so foreign-key dependencies remain
  valid through final keyframe writes.
- Real local tmux integration uses a per-test `-L ac-test-*` socket and kills
  only that server during teardown. It must never connect to the developer's
  default `agent-cockpit` socket.
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
- Rendered Markdown (single-pass unified pipeline + `rehype-sanitize` +
  DOMPurify): a corpus fixture exercises headings, nested/ordered/task lists,
  tables, blockquote, hr, strikethrough, inline/fenced/indented code,
  autolinks, reference links, footnotes, and images. Assertions cover
  construct presence, cross-block reference-link resolution, top-level
  `data-start-line`/`data-end-line` annotation, changed-block callout matching
  against `changedLineSet`, `rehype-highlight` token emission, sanitization
  (no `script` survives; no `javascript:` href; no inline event handlers),
  and the safe-link/image transform (`target`/`rel`/`data-external` on
  absolute anchors, `data-localpath` on relative links, `data-inert` on
  empty/unsafe anchors, and `data-fragment` plus scoped scroll/focus navigation
  for matching authored and generated in-document fragment targets; blocked image src
  collapses to alt-text span).
- **Bare/inline HTML in Markdown prose** (GitHub-style sanitation,
  `docs/ARCHITECTURE.md` "Untrusted repository content"): positive cases
  (`<details>`, `<sub>`/`<sup>`/`<kbd>`, hand-authored tables) render;
  negative cases (`script`/event-handler attributes/`iframe`/`style`/`class`/
  disallowed protocols) are stripped; the two deliberate protocol widenings
  (`href` gains `file:`, `img[src]` gains `data:image/*`) are scoped exactly
  — a non-image tag or a non-image `data:` MIME type is rejected; a
  ` ```html ` fence still renders as a plain code listing, matching GitHub;
  `rehype-sanitize` runs before `rehype-highlight`/the safe-link/image
  transform. SECURITY: a forged `data-start-line`/`data-mermaid-id` on
  attacker-authored bare HTML resolves to the true re-derived value (or is
  absent), never the forged one — the schema never allowlists these four
  attributes by name; see CLAUDE.md's "Inline-HTML sanitizer schema must
  never allowlist this app's own trusted attributes by name". ROBUSTNESS: a
  document with thousands of unclosed inline-HTML tags (a `rehype-raw`
  stack-overflow trigger) degrades to a visible "could not render" state, not
  a silently-blank panel. A GFM footnote id and its referencing href stay
  consistent (`clobberPrefix` override). A `<pre>`/`<code>` code-block pair
  never both carry the anchor (only `<pre>` never does).

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
- **Cockpit-mux renderer/controller boundary:** terminal-registry tests prove a
  Cockpit-mux terminal configured for `dom` instantiates `XtermPaneRenderer` and
  receives the same daemon-owned scrollback hydration as WTerm. The packaged Playwright topology suite
  runs the broad persistence/navigation path on that xterm adapter, then switches
  to `wterm` for the retained-DOM-grid path. This keeps mux protocol/lifecycle
  regressions independently testable from WTerm rendering behavior.
- **Cockpit-mux backend:** focused Go tests cover the standalone daemon,
  persistence/recovery, PTY handoff, protocol framing, and platform artifacts;
  focused TypeScript tests cover manifest selection/checksums, local and remote
  launchers/reattach, raw-byte terminal transport, copy-mode/broadcast/session
  controls, and silent preservation of the saved backend for existing installs.
  A staged macOS package was
  verified after code signing by rechecking each embedded mux artifact checksum
  and the outer-app signature. A Playwright-driven, isolated Electron run verifies
  the manifest-selected local mux daemon, the private packaged `cockpit-wasm:`
  asset endpoint, DOM WTerm initialization, and a real command input/output round
  trip. Remaining remote-host and broader Electron scenarios remain tracked as an
  open validation gate, rather than being counted as passed by focused tests.
  The protocol path additionally splits a single producer read into ordered 1 MiB
  chunks and caps an individual `pane.output` response at 8 MiB, leaving framing
  headroom below the 16 MiB wire limit; its deterministic stream test covers both
  bounds and sequence continuity.
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
- **JSON/YAML structural folding** (`src/renderer/content/folding/`,
  `foldingRows.ts`): the fold model — source-slice region boundaries, sort
  order, single-line-container exclusion, JSONC tolerance (comments, trailing
  commas), total error recovery (malformed input never throws), multi-document
  offsets and per-document anchor scope, block-scalar header/end ranges,
  backward anchor-token scanning, `offsetToLine`/naive-split agreement, a
  `structuredClone` round-trip per fixture, and the grep-pinned guardrail that
  the model code never calls a full-value parse/resolve API
  (`.toJS()`/`JSON.parse`/`yaml.parse`/etc.) in `foldModel.test.ts`,
  `jsonFold.test.ts`, `yamlFold.test.ts`; the row projection — the
  hide/suffix rule, overlap defense, document grouping, and the
  `lastTouchedLine` regressions against real `yamlFoldModel` output (a
  document-boundary `---` marker preserved, a block scalar's fold row
  correctly anchored) in `foldingRows.test.ts`; the worker client — cache
  hit/miss/eviction and all worker-failure fallback paths (construction
  failure, `postMessage` throw, `onerror`, an error reply) in
  `foldClient.test.ts`; the hook — null-input short-circuit and the
  stale-result guard in `useFoldModel.test.tsx`; settings normalization —
  `structuredFoldMaxMb` clamping/defaulting, and the `structuredFoldReadMaxBytes`
  read-cap-override formula (`local_repo_explorer-ftbq`) — in the settings
  test suite; and `ContentViewer`'s dispatch + degrade — `folding-view`
  dispatch for json/yaml, the over-threshold and at-threshold boundary, an
  unknown/pending size never degrading, confirmed-binary taking precedence
  over the size degrade, neither reclassification ever writing the persisted
  `contentMode` setting, the raised `maxBytes` forwarded to `readFile` for
  json/yaml paths only (never for markdown/text), and — across a
  FoldingView→RawFile remount — every `readFile` call for the same selection
  requesting the IDENTICAL `maxBytes` (the regression guard for keying the
  cap on the pure path class, never `effectiveCls`), in
  `content.test.tsx`/`modeSwitcher.test.ts`.
- **FoldingView component** (`foldingView.test.tsx`, jsdom): collapse/expand
  via click and keyboard (Enter/Space) with `aria-expanded` tracking state;
  the folded placeholder chip's item count and prefix/suffix text; original
  (never renumbered) line numbers and gutter alignment across the Wrap
  toggle; the degrade notice for an unavailable/errored fold model; grouped
  multi-document rendering (labelled regions and separators) versus the flat
  single-document path; and anchor/alias badge rendering with tooltip text.

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
- **Content-mode matrix** (`npm run verify:content-modes` /
  [scripts/screenshots/verify-content-modes.mjs](../scripts/screenshots/verify-content-modes.mjs)):
  builds and drives the real app via Playwright against rendered evidence for
  the full (class × mode) matrix — see ARCHITECTURE "Content Modes & Bounded
  Binary-Preview Reads"'s Regression Check for the harness's general shape.
  This harness is the one that extends to the JSON/YAML structural-folding
  surface (Content-body zoom-in/out/reset geometry plus in-preview fragment
  scroll/focus, folding-view dispatch, collapse/expand against the real DOM,
  multi-document stacking, anchor/alias badges, gutter alignment, and — since
  `local_repo_explorer-ftbq` landed — the real threshold-degrade contract: a
  file sized inside the raised read-cap band degrades to the plain
  highlighted view with no fold toggles and its real content visible, while a
  file sized genuinely above that cap still shows the too-large placeholder
  with no fold toggles offered); the script itself is the source of truth for
  its exact fixtures and assertions.
- **Cockpit mux interaction-regression gate** (`tests/e2e/mux-topology.spec.ts`):
  this is a serialized, packaged Electron Playwright suite run with an isolated
  user-data directory and hidden renderer. It is the acceptance gate for the
  mux terminal surface, not a smoke test. Each scenario must pass with the
  real daemon through the xterm control adapter before the mux topology package
  closes. WTerm renderer validation remains a separate renderer gate and must
  not mask mux model defects:
  - **MUX-E2E-01 Navigation and creation:** a focused pane accepts the
    advertised keyboard operations for horizontal/vertical split, new/close
    window, left/right/up/down pane traversal, previous/next window, and zoom;
    the packaged keyboard contract is exercised under both xterm and WTerm and
    moves
    focus to the selected destination.
  - **MUX-E2E-02 Input ownership:** input is delivered exactly once to the
    active pane, never a stale or hidden pane; explicit Broadcast is the sole
    exception and its window/session scope is visible in the UI.
  - **MUX-E2E-03 Layout and close:** horizontal and vertical split trees plus
    ratio changes survive selection; closing a pane/window normalizes active
    identity and cannot reuse a disposed pane's renderer or contents. The
    xterm path creates three windows and closes them in succession through the
    visible controls, verifying the daemon snapshot and visible terminal never
    resurrect a closed window. MUX-E2E-05 separately verifies the same xterm
    topology through reload and clean relaunch.
  - **MUX-E2E-04 Screen continuity:** first attach starts at the live tail and
    follows output. Visiting a different pane/window and returning preserves
    each terminal's live visible screen and deliberate scrollback position;
    no blank or stale screen is acceptable.
  - **MUX-E2E-05 Persistence:** renderer reload and clean app relaunch restore
    topology, active window/pane, zoom, split ratio, daemon scrollback, and
    visible live tail without duplicate panes or historical output replay.
- **Process-leak acceptance** (`npm run test:e2e:mux`): the Node supervisor
  gives each Playwright run its own process group, profile root, and tmux socket;
  after normal completion or runner failure it terminates remaining children,
  removes only that run's temporary root, kills only its tmux server, and asserts
  no app/mux process still references the run root. The deliberate
  `npm run test:e2e:mux:verify-cleanup` mode waits until the packaged app is
  live, sends SIGKILL to Playwright's whole process group, and passes only if
  the supervisor reaps the process group, scoped app/mux, and unique tmux
  server. `npm run test:e2e:mux:guardian` separately SIGKILLs the public
  supervisor while a packaged app, mux daemon, Playwright run, and isolated
  tmux server are live, then verifies all are gone. The isolated launcher has
  an equivalent cleanup regression at
  `node scripts/test-isolated-run-guardian.mjs`. The supervisor self-test
  separately exercises runner cleanup with a helper child without requiring a
  packaged app.
  - **MUX-E2E-06 Isolation and recovery:** topology, input, replies, geometry,
    close, and history remain scoped to their project even when same-key panes
    finish asynchronously in the background; a missing/failed terminal operation
    leaves an inspectable recovery state instead of a blank region. The packaged
    suite creates two live projects with the same key and verifies each daemon's
    independent output. Remote adapter tests normalize the same topology events,
    while live remote-host integration remains a separate transport gate.
  - **MUX-E2E-07 Session-owned window placement:** window IDs are identities,
    not order. Create windows whose IDs do not sort in creation order, select
    them in a different order, then validate that tabs and previous/next
    navigation use the logical session's durable placement relation. Closing the
    first, middle, or last placement removes only that entry and preserves the
    relative order, active-window fallback, each surviving window's selected
    pane, and every marker through reload, clean relaunch, daemon recovery, and
    handoff.

  Historical regressions covered by this gate include initial-scroll following,
  duplicate keystrokes after a split, left/up traversal failure, shortcuts
  swallowed by a terminal, window-return blanking, closed-pane content being
  shown in a new window, one-direction-only splits, and ambiguous mux action
  labels. Direct Kitty PNG/RGB/RGBA graphics has a separate packaged-WTerm
  acceptance path: it verifies the PTY/mux reply route plus deterministic overlay
  dimensions and pixels. Its live-daemon lifecycle scenario reloads and reconnects
  a graphics-bearing WTerm pane (including a PNG without an explicit grid span),
  asserts text then quiet graphics-seed ordering and retained pixels, and proves
  xterm receives no graphics seed. A newly launched
  daemon must deliberately omit graphics. No other interaction exception is allowed.

### Cockpit mux state-space acceptance plan

The interaction-regression gate is generated from a bounded topology state
space, not from an unbounded hand-written list of terminal examples. The
generator must cover every valid combination of the following dimensions, with
the listed reductions only where states are observationally equivalent.

| Dimension                       | Values / equivalence classes                                                                                                         | Why it changes behavior                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logical-session cardinality `S` | exactly one interactive logical session per project                                                                                  | Cockpit's project→interactive-session mapping is 1:1. The private Run TTY is transport-isolated and must never become a terminal window/session.                                                                       |
| Window cardinality `W`          | one, two, three windows in the selected logical session                                                                              | Covers root, adjacent, and non-adjacent window traversal plus successive destruction.                                                                                                                                  |
| Window placement `Q`            | creation order; non-creation active order; close first/middle/last; recovered order                                                  | Separates a window's opaque identity from its session-local position and catches lexical-ID sorting or placement resurrection.                                                                                         |
| Per-window pane tree `P`        | root; horizontal pair; vertical pair; horizontal-then-vertical; vertical-then-horizontal; three-leaf same-axis tree                  | These are the minimum non-isomorphic shapes for directional navigation, nesting, and resize ownership. Trees are capped at three leaves for exhaustive transition coverage; deeper trees use the same recursive rules. |
| Active leaf `A`                 | first, last, branch-adjacent, and every leaf with a valid directional neighbor                                                       | The active leaf determines which creation source, direction, and close survivor is legal.                                                                                                                              |
| Transition `O`                  | split right, split below, new window, left/right/up/down, previous/next window, close pane, close window, zoom/restore, resize ratio | These are the user-visible topology mutations and navigation operations.                                                                                                                                               |
| Trigger `G`                     | advertised keyboard shortcut                                                                                                         | The renderer-agnostic frontend command layer must produce the same daemon topology, visible selection, and input focus under xterm and WTerm.                                                                          |
| Lifecycle boundary `R`          | steady state; immediately after mutation; delayed/out-of-order inspection; renderer reload; clean app relaunch; final-empty reload   | This catches stale snapshot, terminal-registry, and persistence failures that a steady-state assertion cannot.                                                                                                         |

For a bounded topology `t = (S, W, Q, P, A)`, the required scenario family is:

```text
Scenario(t) = ValidTransitions(t, O) × {keyboard} × {xterm, WTerm} × R
```

`ValidTransitions` contains each directional edge that actually exists in `P`,
each valid source leaf for creation, and each legal non-final/final deletion.
Invalid combinations (for example `ArrowUp` from a horizontal-only tree or
closing a window that is no longer in the selected session) are not silently
omitted: they are negative cases that must leave topology and visible content
unchanged with an inspectable error. Pairwise coverage is required across all
remaining dimensions. In addition, the following higher-order paths are
mandatory because pairwise generation cannot expose their historical races:

1. Create three windows in a known placement order, select them in
   non-creation order, and close them in first/middle/last placement order.
   Verify that neither a closed window nor its panes return, that every survivor
   retains its relative order and saved active pane, and that no lexical ordering
   of window IDs replaces the stored placement after recovery.
2. Create both split directions in one window, traverse every directional edge,
   create a sibling window from each active-leaf class, then return through each
   window edge.
3. Start a create/split, a topology inspection, and a close in deliberately
   overlapping order; only the daemon-authoritative post-mutation topology may
   remain visible.
4. Exercise every topology shape through reload and clean relaunch, including
   the empty result after the final pane/window closes.
5. Repeat the preceding paths with a second live project using a same-named
   terminal key. Project boundaries, rather than multiple interactive sessions
   within one project, are the isolation boundary.

#### Bidirectional navigation and daemon-owned focus

For every valid pane-layout edge `(source, direction, target)`, run both
directions through both triggers: `source --direction--> target` and
`target --opposite(direction)--> source`. Each leg must assert the
daemon-reported `activePaneId`, the focused DOM textarea, and new marker output
typed with `page.keyboard` without clicking the destination first. This makes
left/up traversal as required as right/down traversal and proves focus moves
with navigation rather than only the daemon selection changing.

For every logical session with `W >= 2`, seed a distinct active pane and marker
in each window. For each adjacent pair in both directions, require:

```text
Window A / Pane A2 → Window B / Pane B2 → Window A / Pane A2
```

The return leg must restore `A2`'s marker and real input focus, not merely any
pane in Window A. Cover previous/next keyboard traversal, visible window tabs,
and the three-window wraparound in both directions. Repeat this matrix for two
live projects: focus state and markers from Project A must remain intact while
Project B is selected, and vice versa.

The mux daemon is the focus and placement authority: `activeWindowId` and the
ordered window-placement relation are per project's interactive logical session,
while `activePaneId` is per window. The renderer may restore browser focus only
from that snapshot. Reload, clean relaunch, daemon recovery, and handoff must
reproduce the same `(project, ordered windows, active window, active pane per
window)` map before the next keyboard event is accepted. A private Run TTY must
not replace that selection.

#### Marker oracle for every created terminal panel

Every root session, split pane, and new window must receive a unique,
deterministic marker after it becomes focused. The Playwright fixture derives:

```text
mux:<project-id>:<logical-session-id>:<window-id>:<pane-id>:<creation-generation>
```

It must type a composed `printf`/`echo` command through the real terminal input
and wait for the exact marker in that pane's rendered xterm DOM. The marker is
the visible identity oracle; daemon IDs alone are insufficient.

After every `O × G × R` transition, assert all of the following:

1. The daemon snapshot contains exactly the expected session/window/pane IDs
   and no retired identity.
2. The visible window wrapper contains exactly the expected pane keys; hidden
   wrappers do not steal focus or present active input.
3. The expected pane's textarea is focused after keyboard navigation; use
   `page.keyboard` to type a new marker without clicking it first, then require
   that marker only in the selected pane.
4. Every surviving pane still renders its own original marker and must not
   render any retired pane's marker. A recreated pane gets a new generation,
   never a reused marker.
5. Reload/relaunch preserves every survivor's marker, selected identity, and
   deliberate viewport state. Final-empty reload contains no terminal panel and
   no failed-to-start placeholder.

The implementation should expose the state-space generator's seed, selected
dimension tuple, and marker map in Playwright failure output. A failing tuple
is then reproducible as a compact scenario definition rather than a fragile
recording of clicks.

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
