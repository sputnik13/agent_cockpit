# agent_cockpit — Critical Learnings

Repo-specific lessons agents must apply without rediscovering. Keep entries
short, actionable, and rooted in concrete code paths. Add an entry only when a
non-obvious bug class was found that future changes could re-introduce.

## GUI launches need an explicit PATH bootstrap (tmux/br by bare name)

**Invariant:** The main process spawns local tools by **bare name** — `tmux`
(`providers/local/terminal.ts`, `tmuxControl.ts`, `sessions.ts`) and `br`
(`beads/runner.ts::runBr`) — so it depends on `process.env.PATH` containing
their install dirs. A macOS Dock/Finder/Spotlight launch inherits **launchd's
minimal PATH** (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits Homebrew
(`/opt/homebrew/bin`, `/usr/local/bin`) and user-local (`~/.local/bin`). Without
a fix, the terminal (tmux) and task-detail pane (br) fail ENOENT even though the
tools are installed; a **terminal launch works** because the shell's PATH already
has those dirs — which is why the failure looks intermittent / "but it's
installed". `git` survives via `/usr/bin/git`.

**Required:** `electron/main/index.ts` calls `bootstrapPath()`
(`electron/main/pathBootstrap.ts`) as the **first** step in `app.whenReady`,
**before any spawn**. It imports the user's real login-shell PATH
(`$SHELL -ilc`, marker-delimited so banner noise is ignored), unions in a static
fallback set (`staticPathDirs()`), and dedupes order-preserving (login-shell
PATH wins, then fallbacks, then prior PATH). No-op on win32. `runBr` ENOENT
errors append the effective PATH via `resolveBin('br')` so a genuinely-missing
tool reads as setup, not a bug. Home-grown (no runtime dep) to stay inside the
existing spawn seams.

**Regression check:** launch the packaged app from the Dock (NOT a terminal) on a
host where tmux/br live only in Homebrew/`~/.local/bin`: a terminal must open and
the task-detail pane must load comments without "not found". Do not move
`bootstrapPath()` after IPC/session wiring, and do not start spawning tools from
module top-level before `whenReady` (the bootstrap runs in `whenReady`).

## Dev-environment memory cap (systemd-scope) two-knob invariant

**Invariant:** The remote dev-env `systemd-scope` cap (`SystemdScopeLauncher` /
`systemdScopeWrap` in `electron/main/providers/remote/envLauncher.ts`) starts the
shared cockpit tmux server inside `systemd-run --user --scope … -p MemoryMax=NM`
with BOTH of these, or the cap silently fails to do its job:

- **`env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR`** on the tmux server. A
  systemd-built tmux (e.g. 3.6a on Arch) moves every new pane into its OWN scope
  `tmux-spawn-<uuid>.scope`, which is a sibling of the cap and **uncapped** — so the
  cap ends up holding only the idle server (`Tasks: 1`) and the actual dev work
  escapes. Denying the SERVER the systemd user bus disables that pane-scope spawning,
  so panes inherit the server's cgroup (the cap). The `-CC new-session` opener client
  may keep its bus — only the server gates scope creation. (`-L` sockets live in
  `/tmp/tmux-<uid>`, not `XDG_RUNTIME_DIR`, so unsetting it doesn't move the socket.)
- **`-p OOMPolicy=continue`**. Default scope OOMPolicy makes systemd mark the scope
  `failed` on a cgroup OOM and tear down the WHOLE server (every session/pane on the
  host dies). `continue` lets the kernel OOM-kill only the offending process(es)
  (`MemoryOOMGroup` defaults to no → per-process) and keeps the server + other panes
  alive.

**Granularity:** the cap is **per-host** (the `-L agent-cockpit` socket is one server
per host, one session per project), so 16 GB is a shared ceiling across all projects
on the host, not per-project. True per-project caps need a per-project socket (deferred).

**Regression check:** on a lingering-enabled Linux host, after a fresh connect,
`cat /proc/<pane_pid>/cgroup` for a control-mode pane MUST contain
`cockpit-devenv.scope` (not `tmux-spawn-*`); a memory bomb in a pane must OOM-kill only
that process (`memory.events` `oom_kill>0`, `oom_group_kill=0`) with the scope staying
`active` and other panes alive. The cap only binds a FRESHLY-created server —
`tmux -L agent-cockpit kill-server` to re-cap a running one.

## beads_rust status model (ready vs not-ready; close, never free-text)

**Invariant:** `br ready` (what agents pick up) is **`open` AND unblocked AND
not-deferred** — *only* `open` is ever ready. `br`'s `Status` is the eight-value
enum `open | in_progress | blocked | deferred | draft | closed | tombstone |
pinned` `anyOf`'d with a bare string, so **any free-text status validates**
(`br update --status done` succeeds). `--status` refuses only `closed`/`tombstone`.

**Rules:** claim with `br update --claim` (→ `in_progress`); **finish ONLY with
`br close`** (→ `closed`) — the one state that is both never-ready and truly
terminal, and the only one that unblocks dependents and feeds `br changelog`;
snooze with `br defer`/`undefer`; leave `blocked` to dependency edges (it is
derived). **NEVER** `br update --status <free-text>` (`done`/`completed`/…): the
bead is then neither `open` (never shows ready — looks abandoned) nor `closed` (so
it keeps blocking dependents and is dropped from changelogs) — a limbo state.

**Cockpit rendering (aligned to the set):** `deriveState` in
`src/renderer/beads/graphSelectors.ts` maps `closed`/`tombstone` → `done`
(terminal); stored `blocked` → red; `deferred` → Deferred; `draft` → Draft;
`in_progress` → its state; **only `status === 'open'` → Ready** (when unblocked).
Everything else — `pinned` and any free-text value (`done`/`completed`/…) →
`unknown` ("Other status", warn): never Ready, never hidden, so the bad status is
visible and gets corrected (it still blocks dependents in `br`). Do NOT reintroduce
the old `unknown → ready` fallback. Full model + transitions:
[docs/DESIGN.md](docs/DESIGN.md) "Bead lifecycle states & transitions".

## beads_rust dependency direction (workgraph)

**Invariant:** A normalized `BeadsDep { from = issue_id, to = depends_on_id }`
means *`from` depends on `to`* (beads_rust stores `br dep add <issue>
<depends-on>` as `(issue_id, depends_on_id)`). So for a `blocks` edge **`to`
blocks `from`** — `from` is the blocked/dependent node. `parent-child` edges are
`{from = child, to = parent}` (structural hierarchy only).

**Why this matters:** the renderer once read this inverted (treating `from` as
the blocker of `to`), which marked the *wrong* side blocked. Verify against
`br blocked`: it reports the `from` (issue_id) as blocked by its `to`
(depends_on_id). The single source for all derivation is
`src/renderer/beads/graphSelectors.ts` (`hasOpenBlockers`, `edgesFor`,
`deriveState`, `childrenOf`); `graphLayout.ts` and every view consume it. Do not
reintroduce a per-view direction guess.

**State model:** `deriveState` is the one place mapping `(status, edges)` to a
render state. Three distinct kinds of "blocked": `blocked` = stored
`status === 'blocked'` (red, urgent, top), `dep_blocked` = open `blocks` dep
(yellow, informational), `child_blocked` = epic with open children (yellow,
app-derived — beads_rust does NOT auto-block epics). Only the explicit flag is
red. `isTerminal` = closed/tombstone/deleted.

**Regression check:** the open epic with a `blocks` dependency to open work must
render yellow `dep_blocked` (not red), matching `br blocked`; an issue whose
stored status is `blocked` renders red and sorts to the top of the List.

## Workgraph refresh keeps the view MOUNTED (cold-load spinner only)

**Invariant:** A workgraph refresh — a bead action from Task Detail
(`beadsClose`/`beadsReopen`/`beadsCreate` → `load()`), or a `.beads` watch event
routed through `panelDataSync` → `load()` — must update the data **in place**
without unmounting the rendered view. `BeadsPanel`'s `renderBody` shows the
full-panel `<Spinner/>` **only on a cold load** (`loading && graph == null`); when
a graph is already present it keeps rendering the current view (Tree/Graph/Flat/
Columns) through the `loading:true → false` flip.

**Why:** `beadsStore.load()` sets `loading: true` at the **start of every**
(re)load. `TreeView`'s per-row collapse is local `useState(false)` keyed by
`issue.id`; a plain re-render with a replaced `graph` object **preserves** it
(stable keys → React reconciles, never remounts). But swapping the whole body to a
spinner **unmounts** the view, so the remount after `loading:false` **re-expands
every collapsed node** (and drops scroll/selection) — and flashes a reload on
every action. Showing the spinner only when there is no graph yet keeps the
mounted instances alive across a refresh. Do NOT restore the unconditional
`if (loading)` spinner. (Persisting collapse across project/view switches — which
*do* legitimately remount — is a separate, not-yet-done concern.)

**Regression check:** in Tree view, collapse a parent, then act on a bead (or let
a `.beads` watch reload fire): the parent stays collapsed and no spinner flashes;
the initial cold load still shows the spinner. Covered by the deferred-read test
in `beads.test.tsx` ("preserves tree collapse across a reload").

## tmux control mode (`-CC`) byte handling

**Invariant:** The entire `-CC` data pipeline — from node-pty to the renderer
xterm — MUST carry raw bytes. Never let any layer UTF-8-decode the control
stream into a JavaScript string.

**Why this matters:** tmux's `%output` notifications only octal-escape control
bytes (`< 0x20`) and backslash. **Bytes `> 0x7E` (the UTF-8 sequences for every
non-ASCII Unicode glyph — powerline arrows, box-drawing, emoji, etc.) are
emitted verbatim.** If any layer decodes the chunk as UTF-8 into a JS string,
those raw bytes become Unicode codepoints (e.g. `U+E0B0`), and downstream
byte-extraction (`charCodeAt(i) & 0xff`) truncates each codepoint to its low
byte — destroying every multi-byte glyph. Result: every rich TUI (Claude Code,
htop, vim, lazygit, …) renders as garbled replacement chars.

**Required configuration:**

- `electron/main/providers/local/tmuxControl.ts` spawns node-pty with
  `encoding: null` so `onData` delivers raw `Buffer` chunks. Do not remove this.
- The shared parser (`src/shared/tmux/parser.ts`) accepts `string | Uint8Array`
  but ONLY the `Uint8Array` path (which uses `latin1Decode` to map each byte to
  a char 0..255 1:1) preserves the wire faithfully for `%output`. Feeding a
  UTF-8 string is wrong for production data.
- `src/shared/tmux/codec.ts::decodeOutput` assumes its input string was produced
  via the latin1 1:1 byte-to-char mapping (or contains only ASCII escape
  sequences). It does `charCodeAt(i) & 0xff`, which only works when chars map
  back to bytes.
- The renderer sink in `src/renderer/tmux/controlPaneRegistry.ts` passes
  `Uint8Array` straight to `term.write(...)`; xterm UTF-8-decodes it. Do not
  intercept with a `TextDecoder` mid-stream unless it is stateful (`{stream:
  true}`) AND per-pane — multi-byte sequences can span writes.
- The **capture-pane seed** in the same registry has a subtle twist:
  `parser.feed(Uint8Array)` stores reply lines as **latin1-mapped strings**
  (each JS char code = the original byte 0..255). The seed must re-encode that
  string back to a `Uint8Array` (`bytes[i] = text.charCodeAt(i) & 0xff`) before
  `term.write` — otherwise xterm reads bytes ≥ 0x80 as Unicode codepoints, the
  C1 control bytes (0x9B CSI, 0x90 DCS, 0x9D OSC, …) put the VT parser into
  unrecoverable states, and you get `xterm.js: Parsing error: [object Object]`
  on every captured pane containing escape sequences. Test: open a fresh
  control-mode terminal; if any pane logs Parsing error, the seed is going
  through as a string again.

**If a future transport (e.g. remote/SSH control mode) is added:** it must do
the same — deliver raw bytes from the wire to `parser.feed(Uint8Array)`. A
transport that hands the parser a UTF-8 string will silently break every rich
TUI.

**Regression check before changing anything in this pipeline:** open a
control-mode terminal and run a TUI that uses powerline glyphs or box drawing
(`vim`, `htop`, `claude`). Garbled glyphs = the invariant has been violated.

## Control-mode input is chunked by SIZE only, all `send-keys -H` (never split escape sequences)

**Invariant:** A `send-keys` command is written to the tmux `-CC` stdin as a
**single command line** (`tmuxControl.ts::command` → `proc.write(...\n)`), and
tmux/PTY **silently drop an over-long control-command line** (PTY canonical
`MAX_CANON` ≈ 4096; tmux's own command-line buffer is a second ceiling). So a
large paste sent as one `send-keys` vanishes with no error while small input
works — the classic "big paste does nothing" symptom.

**Required:** the chunking lives in the **main-process manager's `input()`**
(`LocalTmuxControlManager` / `RemoteTmuxControlManager`), the single seam for
keystrokes, paste, AND the mouse-wheel `Uint8Array` seq. It calls
`buildSendKeysCommands(paneId, input)` (`src/shared/tmux/commands.ts`), which
sends **every byte via `send-keys -H` (raw hex)**, chunked **only for size** via
`chunkBytesForSendKeys` (`MAX_SEND_KEYS_CHUNK_BYTES = 256` → command line < ~800
chars, never splitting a multi-byte UTF-8 codepoint across a chunk). A mouse
report / keystroke / small paste fits in one chunk → one atomic `send-keys -H`.
`input()` issues the chunks **in order, awaited sequentially**. The renderer
(`tmuxStore.sendInput`) stays dumb: it hex-encodes once (`toHex(data)`) and makes
a single `input()` IPC call — main does all splitting. One main-side seam covers
**both** transports; do not move chunking back into the renderer.

**CRITICAL — do NOT split input by byte class (e.g. printable via `send-keys -l`,
controls via `-H`).** That puts the ESC byte (control) and the rest of an escape
sequence (printable) in **separate** `send-keys` commands. They arrive
back-to-back locally (fine) but over **SSH the inter-command latency exceeds the
receiving app's escape-sequence timeout**, so the app reads a lone ESC then
literal text — corrupting mouse reports (`\x1b[<…M` typed as garbage), arrow/
function keys, and bracketed-paste markers (`\x1b[200~`/`201~` separated from
content, so a paste registers "one line at a time"). This was a real remote-only
regression (`local_repo_explorer-gtls`); all-`-H` keeps each input event's bytes
contiguous. A large paste still chunks by size, but its bracketed markers stay at
the ends and the receiving app buffers `200~`..`201~` across the chunks. If
genuinely-large *atomic* paste ever matters, use tmux `paste-buffer`, never a
per-byte-class split.

**Do NOT add bracketed-paste markers (`ESC[200~`/`201~`) ourselves.** xterm.js's
own paste handler already wraps pasted content **conditionally** on the pane
app's bracketed-paste mode (DECSET 2004) before `onData` fires. Adding our own
would double-wrap, and wrapping **unconditionally** leaks a literal `200~`/`00~`
into apps that never enabled 2004 — the exact bug class iTerm2 documents.

**Lessons copied from iTerm2's tmux integration (so we don't relearn them):**
- iTerm2 splits long `send-keys` into **sub-1024-byte command lines** for this
  same dropped-line reason — our 256-byte payload cap is the same defense.
- iTerm2 adds bracketed-paste markers **only when the app enabled DECSET 2004**
  (terminal-tracked), never unconditionally — hence we leave markers to xterm.js.
- iTerm2 hit a real **"paste nothing" bug from splitting a codepoint at a chunk
  boundary** — hence the UTF-8-codepoint-safe boundary back-off.
- References: iTerm2 tmux integration docs
  (`https://iterm2.com/documentation-tmux-integration.html`); Paste Bracketing
  wiki (`https://gitlab.com/gnachman/iterm2/-/wikis/Paste-Bracketing`); DeepWiki
  paste operations (`https://deepwiki.com/gnachman/iTerm2/4.3-paste-operations-and-string-utilities`);
  leaked-marker write-up (`https://shivankaul.com/blog/paste-bracketing-iterm2`).

**Regression check:** paste a multi-KB block into a control-mode pane on **both**
local and remote — all of it must arrive. In an app with bracketed paste on
(`zsh`, `vim`) a paste must NOT show a literal `00~`/`200~`, and small
keystrokes must still send as one `send-keys` call.

## Connection state has ONE authoritative owner (main); sessions are background-live

**Invariant:** Per-project connection state is owned by the main-process
`ConnectionMachine` (`electron/main/providers/connectionMachine.ts`) with guarded
transitions. It is the single source of `ConnectionStatus`, forwarded to the
renderer via one `evt:status`. The status indicator, terminal control session,
and Changes/Explorer/Workgraph panels are **pure derivations** of that status
(`sessionStore` + `isConnected`/`isDisconnected` selectors).

**Every live session stays fully active — there is NO warm/hot distinction.**
`suspend()`/`resume()` (and `isSuspended()`/`LocalWatchManager.setPaused`) are
**removed**. `SessionManager.activate()` only sets/persists `activeId`; it never
pauses another session. A backgrounded session keeps its terminal, its watch, and
its helper RPC fully live, so its per-session data (Changes, Workgraph) stays
continuously current. Per-session data is **resident in memory until the session
ends** (explicit kill via `SessionManager.close`, or remote idle aging-out — see
the session-liveness section). Liveness is **lazy**: a project becomes live when
first activated, not pre-connected on boot.

**Per-session data are pure derivations of `(activeId, perSessionStatus,
byProject slice)`.** `changesStore`/`beadsStore` hold one `byProject[projectId]`
slice per live session; active-slice selectors render `byProject[activeId]`. A
single renderer `panelDataSync` orchestrator drives load/refresh/clear off
**per-session connection status + `projectId`-routed watch events**, never panel
focus or `activeId` alone. A panel MUST NEVER show another project's data, even
transiently; a cold/absent slice renders that project's own
loading/disconnected affordance.

**Do NOT** reintroduce a parallel "connection-ish" state (e.g. a renderer
`ControlSessionStatus` enum, a provider `statusValue` consumed independently of
the machine, or panels reacting to `activeId` alone instead of connection
status), and do NOT reintroduce `suspend()`/`resume()` or any second
"connection truth". Multiple connection truths that can disagree is exactly the
bug class this replaced: disconnect not reflected, terminal not recovering after
reconnect, and panels showing a stale project's data.

**Remote `connected` means helper-RPC-ready.** For remote, `toConnected()` fires
**after** `RemoteHelperLauncher.launch()` resolves (RPC proven), not on raw
socket-up; socket-up maps to `connecting`. A read issued the instant a project
reports `connected` MUST NOT fail "helper unavailable". `connecting→disconnected`
is a **legal** edge (a clean drop mid-provision resolves to `disconnected` rather
than stranding the machine); `connecting→failed` is the thrown-error edge. Local
projects short-circuit to `connected` (already "ready").

**Three ordering/teardown traps that already bit us, keep them fixed:**

- **Wire status BEFORE connect.** `SessionManager.open()` subscribes to provider
  status before calling `connect()`. Wiring after connect drops the first
  `connecting → connected` transition into the void and the UI sticks on the
  `disconnected` fallback.
- **Disconnect = symmetric teardown.** On the `disconnected` transition, dispose
  the project's `controlPaneRegistry` entries (`disposeProject`) AND evict the
  IPC `tmuxControl`/`tmuxDisposers`/`termDisposers` caches (via
  `SessionManager.onEviction`). `controlPaneRegistry.acquire()` only binds a
  pane's output sink when it *creates* the entry, and `activeControl()` only
  wires a manager's notifications for a *fresh* subscription. If teardown is
  asymmetric, a reconnect re-acquires a cached pane/manager with no sink/no
  forwarder — input reaches tmux but no live `%output` renders (blank terminal),
  or the terminal never recovers at all.
- **Per-session watch teardown is symmetric.** The session-owned watch (one per
  live session, started on `connected`) MUST be torn down on the provider's
  **status → disconnected/failed** transition AND on `onEviction`. A plain
  `SessionManager.disconnect()` keeps the session in the map and does **not** fire
  `onEviction`, so wiring watch-stop only to eviction leaks the watcher on a plain
  disconnect; the renderer slice is correspondingly cleared (`clearForDisconnect`)
  on disconnect and evicted (`evict`) when the project is removed.

**Regression check:** connect a remote project, disconnect (status → red,
logged in the diagnostics window), reconnect → the terminal must re-acquire,
re-focus, and show live output without an app restart; panels reload. With
projects A and B both connected and A active, mutate B (commit / file write / `br`
mutation) → switching to B shows B's current data with no spinner and no manual
refresh; A→B→A never shows the other project's data at any frame.

## Control-mode reconnect is epoch-driven, NOT status-driven

**Invariant:** A remote `tmux -CC` control channel reattaches **independently of
the `ConnectionMachine`**. On a silent flap — network/keepalive blip, sleep/wake,
or the watchdog failing the link — `RemoteTmuxControlManager.scheduleReattach`
(`electron/main/providers/remote/tmuxControl.ts`) opens a **fresh** channel and
re-attaches to the surviving remote session while the machine stays `connected`
the whole time. So **no `connecting`/`disconnected`/`connected` transition fires**,
and renderer re-init MUST NOT be inferred from connection status — the old status-
gated `initialized`-once guard skipped re-init on every reattach, which is exactly
what left the window list stale (until a manual window switch) and pane displays
frozen (until a manual refresh).

**Required:** every control manager (local + remote) keeps a monotonic `epoch`,
bumped on each successful attach (first open AND every reattach), and emits a
synthetic `{ type: 'attached', epoch }` through the existing `onNotification` →
`evt:tmux` seam. The renderer (`src/renderer/tmux/controlSession.ts`) keys re-init
on `channelEpoch !== initializedEpoch` (per project), running an **authoritative**
`syncFromTmux` (folds `list-windows` AND **prunes** windows absent from it — a
window closed during the drop replays no `%window-close`), reserved-window
reconcile, `restoreActiveWindow` (adopts tmux's session-active window via a
synthetic `session-window-changed` so reconnect focuses the LAST-worked window,
not `tabWindows[0]`), then fires `subscribeReinit` so `ControlTerminalPanel`
mirrors the toolbar HARD refresh (`hardRecoverTab` capture-pane re-seed of
normal-screen panes — alt-screen gated to repaint-only, no runaway scroll — plus a
`nudgeClientSize` resize round-trip). Re-init single-flights with a pending
re-drain (catch a mid-sync epoch). It marks the epoch initialized **only when
`syncFromTmux` actually read a non-empty window list** — a just-attached `-CC`
session is briefly not queryable (empty/errored `list-windows`), and marking it
then stranded the window list until a manual switch (the "wrong until I switch
windows" bug on fresh connect AND reconnect); an empty read instead schedules a
**bounded** retry (~200 ms × 15) that converges with no user action and cannot
spin on a dead session.
`resetControlSession(projectId)` is **per-project** (keeps the shared subscription
+ that project's `channelEpoch`, so a backend switch with tmux still open still
re-inits and one project's disconnect never clobbers another). The
`onReconnecting`/`onReattached`/`onReattachExhausted` manager hooks drive
`machine.toReconnecting/toConnected/toFailed` for an honest status dot —
**observability only**; do NOT gate re-init on that status. Do not reintroduce the
boolean `initialized` guard or a status-inferred re-init. Full design:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Control-channel reattach & re-init".

**Regression check:** on a remote project, force a `-CC` flap (kill the SSH
transport, or sleep/wake the host) so it auto-reattaches with NO user action: the
window list and every pane display must be correct with no manual refresh/window
switch, and the focused tab must be the window last worked in (not the first).

## Filesystem watch: single-source "what to watch"

**Invariant:** "What to watch" has exactly **one** definition:
`src/shared/watch/policy.ts`. No layer — local mechanism, remote Go helper, or
renderer store — may add a private watch or exclusion set.

**The watch is main-owned, one per live session over the session lifecycle.**
`SessionManager` starts exactly one watch subscription per session when it reaches
`connected` and stops it on the status → disconnected/failed transition AND on
eviction (keyed by `(projectId, token)` in `watchSubs`). It is **no longer**
renderer `activeId`-driven, and the `watch:subscribe`/`watch:unsubscribe` IPC
channels were **removed** — main subscribes via `provider.subscribeWatch`
directly. Events carry their `projectId` on the wire (`evt:watch {projectId,
event}`); the renderer hub reads that tag and `panelDataSync` routes by
`(projectId, category)` to the right per-project slice. Do not reintroduce a
renderer-driven `watch.subscribe` keyed on `activeId`.

**Required configuration:**

- `LocalWatchProvider` reads exclusions, signal paths, and
  `DIRECTORY_GRANULARITY` from the `WatchSpec` derived by `deriveWatchSpec()`.
  Do not inline regexes or path lists in the local watch implementation.
- The **remote Go helper** (`remote-helper/watch.go`) receives a `WatchSpec`
  over the `watch.subscribe` RPC params. It **must NOT hardcode** its own
  `excludedDirs`. The spec is the single authoring site projected over the wire.
- The **ingest pipeline** (`electron/main/watch/ingest.ts`) runs
  `classifyWatchPath` as the one classification call. Do not add category logic
  in stores or providers.
- The **renderer dispatch hub** (`src/renderer/watch/hub.ts`) routes by
  `WatchCategory` interest. Stores subscribe to the hub; they do not re-implement
  path filtering.
- **Surfacing (Changes list)** uses `isHiddenFromChanges(rel, { showAll })` from
  the policy. `.git` and `.beads` are hidden by default — this is a **display**
  concern, not a watch exclusion. Both remain watched so their events still drive
  refresh signals.

**After changing `remote-helper/*.go`:** the dist binaries are **not checked in**
— they are built by `remote-helper/build.sh`, which runs automatically via the
`predev`/`prebuild` npm hooks (so a normal `npm run dev` / `build` / `package`
regenerates them). The script short-circuits when the source hash is unchanged,
so only a real Go change triggers a recompile; restart the app (or re-run
`dev`/`build`) after editing Go so the rebuilt binary is picked up. The
provisioner re-uploads on reconnect when the hash mismatches — otherwise the
remote runs the stale helper. (Go is therefore a required build dependency.)

**Regression check:** on a remote project, run `br sync --flush-only` (writes
`.beads/issues.jsonl`) and verify the workgraph panel auto-refreshes; also
commit and switch branches and verify the Changes panel auto-refreshes — all
without a manual refresh.

## Working-tree watch mechanism is platform-split (native recursive vs chokidar)

**Invariant:** The local **working-tree** watcher
(`electron/main/providers/local/workingTreeWatcher.ts`,
`createWorkingTreeWatcher`) is split by platform and MUST stay that way:

- **macOS / Windows** → a single `fs.watch(root, {recursive:true})` (FSEvents /
  ReadDirectoryChangesW): ONE handle for the whole subtree, no upfront tree walk,
  no per-file FD. This is the path that keeps large-repo load cheap.
- **Linux** → chokidar. Linux has no recursive inotify; `fs.watch({recursive:true})`
  there is **emulated** by adding a watch per directory (same cost as chokidar)
  AND cannot prune `node_modules` before adding watches (the EMFILE risk
  `NEVER_RECURSE` exists for), and is documented experimental. chokidar's
  `ignored` prunes the descent, so it adds FEWER inotify watches — the better
  Linux choice.

**Why this matters:** chokidar v4 dropped its FSEvents backend and recurses by
walking the tree + opening an `fs.watch` per directory, so on a big repo the old
`chokidar.watch(['.'])` did a full walk and held thousands of handles. Whole-tree
*coverage* is genuinely required (untracked/new files must be seen for the Changes
panel) — but the per-FD cost was chokidar's implementation, not the requirement.
The single native recursive handle keeps the coverage and drops the cost.

**Do NOT** "simplify" to native-recursive-everywhere (regresses Linux to the
EMFILE/experimental path) or back to chokidar-everywhere (reintroduces the
large-repo walk + FD pressure on macOS). Both mechanisms apply the SAME
`gitignore + excluded-segment` predicate — the native path filters in the event
callback (no walk to prune), chokidar via `ignored`. The dedicated
`.git`/`.git/refs`/`.beads` `fs.watch` watchers remain the single source of
git-state/beads signals on BOTH platforms (the working-tree watcher excludes
those segments), so the [filesystem-watch policy](#filesystem-watch-single-source-what-to-watch)
stays the one definition of "what to watch".

**Regression check:** on macOS, open a repo with a large untracked/gitignored
tree (e.g. tens of thousands of files under `node_modules` or a `data/` dir): the
process FD count must stay flat after the watch starts (no per-file growth), and
the Changes panel must still update on an edit, a new untracked file, and a
branch switch. `local.test.ts`'s file-change / git-refs / commit / `beads.db`
integration tests exercise the native path on macOS.

## Control-mode scrollback has a single source (`TERMINAL_SCROLLBACK`)

**Invariant:** Control-mode scrollback depth has **one** definition,
`TERMINAL_SCROLLBACK` (`src/shared/tmux/scrollback.ts`, currently 5000), applied
consistently to **all three** layers that must agree: the tmux server
`history-limit`, the `capture-pane -S` seed depth, and the renderer xterm
`scrollback` buffer. Changing one without the others reintroduces lost/truncated
history on (re)attach.

**Required configuration:**

- The tmux global `history-limit` is set to `TERMINAL_SCROLLBACK` on the socket
  **before the first `new-session`** (`new-session -A` creates the initial pane
  as part of session creation, and `set-option` does not retroactively resize
  existing panes). This is applied in **both** the local opener
  (`electron/main/providers/local/tmuxControl.ts`) and the remote opener — the
  remote path is a parallel implementation and must not be missed.
  - **`set -g` does NOT start a tmux server** — it requires a running one, and on
    a fresh socket fails with `error connecting to <socket> (No such file or
    directory)`. The **remote** opener chains the two tmux invocations in one
    shell command with `&&`, so a failed `set -g` short-circuits and the
    `-CC new-session` never runs — a hard control-mode connect failure that
    presents as the channel dropping a few ms after "open ok" with **no `%exit`**
    (the remote command exited before tmux entered control mode). The opener must
    therefore run `tmux -L <socket> start-server \; set -g exit-empty off \; set
    -g history-limit N` (`\;` reaches the remote shell as a literal `;`, tmux's
    command separator): `start-server` gives `set -g` a server to target, and
    `exit-empty off` keeps that sessionless server alive so the `history-limit`
    survives to the `&&`-chained `-CC new-session` (without it the empty server
    exits between the two invocations and the first cold-start pane falls back to
    tmux's default 2000 scrollback). The **local** opener is exempt from the
    connect bug because it
    uses two **separate** `spawnSync` calls (not `&&`): a failed `set` there does
    not block the subsequent `-CC new-session`. Do not collapse the local opener
    into a single `&&` command, and do not drop `start-server` from the remote
    one.
- The seed passes `capturePane(paneId, { startLine: TERMINAL_SCROLLBACK })` so it
  captures history, not just the visible screen, and the renderer xterm is
  constructed with `scrollback: TERMINAL_SCROLLBACK`.
- The existing latin1→`Uint8Array` seed re-encode (the raw-byte invariant above)
  is unchanged — seeding from deeper history pushes more high bytes through that
  path, so the glyph regression check still applies.

## Reserved control-mode windows reconcile to exactly one of each

**Invariant:** The reserved control-mode windows (`persistent` keep-alive,
`run-N` Run-panel tty) are **reconciled to exactly one of each class on every
attach** via a pure `reconcile()` in `src/renderer/tmux/controlSession.ts`. An
empty `list-windows` reply is an **attach-race / not-ready signal** (a live
session always has ≥1 window) — it is never grounds to create reserved windows;
the ensure bails **without consuming the per-project one-shot init guard** so a
later acquire/sync retries against a populated list. Violating either reintroduces
unbounded duplicate-window accumulation (stray terminal tabs, bloated window
list).

**Required configuration:**

- Reconcile keeps the first of each reserved class by **numeric window-id
  ascending** (stable across reconnects), `kill-window`s the extras, and **never**
  touches real terminal windows (classified via the single `isHiddenWindow`/
  `RUN_RE` definition).
- The surviving Run window MUST end up named literally `run-1` (RunPanel binds
  that exact name); reconcile renames the survivor to `run-1` (`toRename`) so a
  reaped survivor named `run-2` does not silently disable Run.
- Concurrent/retried `acquireControlSession(projectId)` is **single-flight** (one
  in-flight ensure promise per project); the slot clears on settle and
  `initialized` is set only on a non-bail success.

## Control-mode window titles are stable & cockpit-owned (`automatic-rename off`)

**Invariant:** A terminal tab's title is the **tmux window name**, and the cockpit
is the sole author of that name. tmux's default `automatic-rename on` makes tmux
re-derive every window's name from its active pane's foreground command on a
server refresh — and a `new-window` triggers a refresh — so it emits
`%window-renamed` for *idle* windows too. That produced two bugs: a tab's title
drifted to the **last command/cwd**, and **opening a new window relabeled the
existing ones**. `automatic-rename` is therefore pinned **off** at the single
option source `TMUX_SERVER_OPTIONS` (`src/shared/tmux/terminalConfig.ts`),
consumed by **both** the local argv opener (`tmuxServerOptionArgs`) and the remote
shell opener (`tmuxServerOptionShell`) — so a window name only ever changes when
the cockpit (or the user) explicitly `rename-window`s.

**Required:**
- **One creation seam:** every real terminal tab is created by
  `createTerminalWindow()` (`src/renderer/tmux/controlSession.ts`) — used by
  `ensureWindows` (first tab) and all three renderer affordances (the `+` button,
  ⌘T, and the last-tab-closed respawn). It does `new-window -P -F "#{window_id}"`
  then `rename-window -t <id> '#{b:pane_current_path}'`: tmux **format-expands**
  the rename arg to the creation-time cwd **basename** and stores it as a static
  literal (frozen, since automatic-rename is off). This is transport-agnostic —
  tmux computes the basename, so no project-path plumbing is needed and remote
  behaves identically. Do **not** revert any site to a bare `new-window` (it would
  land unnamed → index-only label) or add `set-window-option automatic-rename`
  back on per-window (the global off already covers it; reserved windows keep
  their explicit off only because they predate the global and it's harmless).
- **Label source:** the tab label in `ControlTerminalPanel.tsx` is
  `name && name !== id ? name : String(i + 1)` — the tmux window name, index
  fallback. Do **not** reintroduce `displayName` (the live SCREEN-title scrape) as
  the label; it is **hover-only** now (the tab tooltip), which is what keeps titles
  from drifting per command. The SCREEN-title **stripping** in
  `extractScreenTitle` stays (it prevents garbage `\ek…\e\` glyphs); only its
  promotion-to-label was removed.
- **User rename:** double-clicking a tab opens an inline `<input>`; Enter/blur
  commits via `renameWindow(id, text)`, Escape cancels. The user text is escaped
  `#` → `##` before the rename because tmux format-expands the arg (a literal `#`
  must not be read as a directive). The committed name persists until the user
  renames again or the window closes (automatic-rename off guarantees it).

**Regression check:** open two+ terminal tabs and run different commands in each —
no tab's title changes when a command runs, and creating a new tab does not
relabel the others. New tabs default to the project directory's basename.
Double-click a tab, type a name, Enter → it persists across command runs and tab
switches. `terminalConfig.test.ts` pins `automatic-rename off` in both openers.

## Control-mode tab refresh is two-tier (repaint + resize round-trip; gated re-seed)

**Invariant:** The toolbar refresh button (`refreshActiveTab(hard)` in
`ControlTerminalPanel.tsx`) has two modes, both of which:

1. repaint every pane **from xterm's OWN buffer** via the **non-destructive**
   `recover()`/`recoverTab()` (`controlPaneRegistry.ts`) — refit (`fit`) +
   glyph-atlas rebuild (`webgl?.clearTextureAtlas()` / `term.clearTextureAtlas?.()`)
   + `term.refresh(0, rows-1)`; and
2. force a **real client resize round-trip** via `nudgeClientSize(host)`
   (`controlSession.ts`) — shrink one row, then restore. This is load-bearing:
   tmux only re-emits `%output` (and SIGWINCHes the pane apps) when the client
   size actually CHANGES, so a same-size `pushClientSize` is a tmux no-op — which
   is why a plain repaint rarely fixes mis-wrapped / size-desynced output. The
   manual resize the user does (drag the window) worked for exactly this reason.

**Normal click = tiers 1+2 (always non-destructive).** `recover()` itself MUST
stay non-destructive: do NOT make it dispose the xterm, re-seed from
`capture-pane`, or remount — a re-seed writes the captured screen as plain buffer
lines that a live **alt-screen TUI** (Claude Code, vim, htop) redraws over,
producing **runaway scroll**.

**Shift-click = hard refresh, with a STRICTLY GATED re-seed.** `hardRecoverTab()`
queries each pane's tmux `#{alternate_on}` (`listPanesAltScreen`, one
`list-panes` round-trip) and re-seeds ONLY panes positively on the **normal**
screen (`reseedPane`: clear `ESC[3J ESC[2J ESC[H` + re-write via the shared
`seedBytesFromCapture` latin1 re-encode). Alternate-screen panes get only the
non-destructive repaint and rely on the resize round-trip's SIGWINCH to redraw.
The safety gate is `mayReseed(alt) === (alt === false)`: **unknown /
query-failed / alternate ALL fall back to repaint**, never re-seed. Do NOT widen
`reseedPane` to alt-screen panes or flip the safe default — that reintroduces the
runaway-scroll bug the gate prevents. Both modes work on local and remote
(`capturePane`/`resizeClient`/`command` exist on both transports).

**Ordering trap (keep it fixed):** the resize round-trip's first (shrink) push
runs **SYNCHRONOUSLY** at click time, so it targets the project active **at click
time**; the next-frame restore in `nudgeClientSize` is **guarded on
`activeProjectId`** so a fast project switch never resizes the wrong project. Do
not make the synchronous shrink deferred.

**Related fix:** creating a split now takes **both** visual selection and xterm
keyboard/input focus on the new pane — `split-window … -P -F '#{pane_id}'`
captures the new pane id as a `pendingActivePaneRef`, and the active-pane
resolution prefers it once it lands in `layout` (previously only visual focus
moved; input stayed on the original pane).

**Regression check:** mis-wrap an alt-screen TUI's output, **click** refresh →
the resize round-trip reflows it cleanly with NO runaway scroll, tmux session
intact, diagnostic `trigger=manual-refresh` logged. Desync a plain **shell**
pane, **shift-click** → it re-seeds correctly (`trigger=hard-refresh`); do the
same with a TUI in the pane → it must NOT re-seed (no runaway scroll). Switch
projects during a refresh → the other project is never resized. Create a split →
typing immediately goes to the new pane.

## Remote `ssh2` is encapsulated behind `RemoteTransport`

**Invariant:** `ssh2` (and `@types/ssh2`) is imported by **exactly one file**,
`Ssh2Transport` (`electron/main/providers/remote/transport.ts`). All other code —
`RemoteProvider`, `RemoteHelperLauncher`, `RemoteTerminalManager`, the
control-mode path — depends only on the `RemoteTransport` interface
(`transportTypes.ts`), never on `ssh2` types or a raw client. The
`transport.client()` leak is gone; an ESLint `no-restricted-imports` rule enforces
the boundary. A second transport plugs into `createRemoteTransport()`
(`transportFactory.ts`) without touching consumers.

**Required configuration:**

- Control/RPC channels carry raw `Uint8Array`/`Buffer` end to end (`PtyChannel`/
  `DuplexChannel` `onData` is typed `(b: Uint8Array) => void`); the raw-byte
  invariant above is now a typed contract, not a convention. Do not UTF-8-decode
  in the transport.
- `Ssh2Transport` performs **host-key verification** against the user's
  `known_hosts` (ssh2 `hostVerifier`); a mismatch surfaces as a typed
  `RemoteTransportError` with `phase: 'hostkey'`, not a silent accept. The
  `hostKeyPolicy` is part of the `connect` options contract so any future
  transport satisfies the same verification.
- The ssh2 path **resolves `~/.ssh/config` `Host`-alias fields** (an in-repo
  resolver, `sshConfigResolve.ts`, applied in `Ssh2Transport`) because ssh2 does
  not read `~/.ssh/config` — a project whose `host` is an alias would otherwise
  fail `getaddrinfo ENOTFOUND <alias>`. Only `HostName`/`Port`/`User`/
  `IdentityFile` are resolved (spec-explicit values win, then config, then
  default); the resolver imports only `node:fs`/`node:os`/`node:path` so it does
  not breach the single-`ssh2`-import boundary. **known_hosts verification uses
  the RESOLVED host** (not the alias), so the host-key token matches the real
  host. ProxyJump/`Match`/`Include` and the broader OpenSSH config surface stay
  deferred to the native-ssh transport — do not grow this resolver into them.
- `RemoteProvider` constructs its transport via the factory (not
  `new Ssh2Transport()`), and connection status remains owned solely by
  `ConnectionMachine`.

## Panel focus: visual focus and keyboard focus are separate, routed via one seam

**Invariant:** "Which Dockview panel/tab is active" (visual focus, owned by
`panel.api.setActive()`) and "which DOM element has keyboard focus" are distinct
concerns. Keyboard focus is moved through a single registry,
`src/renderer/workspace/panelFocus.ts` (`focusPanel`/`focusPanelForce`, with a
**pending** target for not-yet-mounted panels, a **suppression** flag for
programmatic layout/preset application, and a **force** variant for explicit
restore/Ctrl+`). `PanelHost` wraps each panel in a focusable root and registers a
handler (default focuses the wrapper only when focus is not already inside it — a
containment guard); panels override via `usePanelFocusOverride` (terminal → active
xterm pane via `FOCUS_TERMINAL_EVENT`; run → command input). `focusMemory.ts` is
persistence only, not a focus mechanism.

**Two focus-race classes bit us — keep them fixed:**

- **Library focus-restore.** The Panels dropdown (`ui/Menu.tsx`, Radix) must keep
  `onCloseAutoFocus={(e) => e.preventDefault()}`; otherwise Radix restores focus to
  the trigger button on close, *after* the selected action moved focus into a
  panel, stealing it back.
- **Re-emitted activation.** `onDidActivePanelChange` must only move focus on a
  **genuine** panel-id change (guarded by a `lastActivePanelId`). Dockview re-emits
  for the *same* panel when focus churns within it, and re-running `focusPanel`
  re-fires the terminal override against the lagging active pane.

Also: `choosePreset` (Cmd/Ctrl+E/R view switch) must `focusPanelForce` the view's
active panel after `loadLayout`, since `loadLayout` suppresses focus during the
layout cascade and nothing else restores it.

**Known open:** keyboard focus does NOT reliably follow a newly-created tmux
**split** inside the control-mode terminal (new windows/tabs work). The Dockview
re-emit guard did not resolve it, so the cause is elsewhere (suspect:
`ControlTerminalPanel`'s deferred-focus / `PaneXterm` active-transition timing).
Diagnose with a focus trace (who calls `renderer.focus()` and for which pane)
before changing logic — do not ship another untested guess.

## Content-panel code views: line-number gutters stay aligned; wrap is a toggle

**Invariant:** In the Content panel's code views — the diff (`DiffView.tsx`) and
raw file (`RawFile.tsx`) — each line is a flex row of fixed-width line-number
gutter(s) + the code. The gutters MUST keep a straight vertical column
regardless of code length, in BOTH the no-wrap (scroll) and wrap modes.

**Why this is fragile:** the row is `display:flex` and the code is pre-formatted
(`white-space: pre`/`pre-wrap`), so its min-content width is the whole line. With
the gutters at default `flex-shrink:1`, a long line's large min-content makes flex
distribute negative free space by **shrinking the gutters** (the code can't shrink
below its min-content) — so long-line rows got a narrower gutter than short-line
rows and the numbers stopped lining up. The fix is two parts, keep both:

- **Gutters are `flexShrink:0`** (DiffView's two inline gutter spans;
  `LineNoteGutter` already uses `shrink-0`) so they never get squeezed.
- **No-wrap rows set `minWidth: 'max-content'`** so the row sizes to its content
  (extending the row + its add/del background) and the outer `overflow:auto`
  container scrolls horizontally — instead of the row staying viewport-width and
  forcing the shrink.

**Wrap mode** is a persisted global toggle (`AppSettings.wrapLines`, default off =
scroll) flipped by the `Wrap` button in the Content `PanelHeader` actions (shown
only for the `diff`/`raw` modes) and threaded as the `wrap` prop into both views.
When on: the row uses `white-space: pre-wrap` and DROPS `minWidth:max-content`, and
the code span gets `flex:1 1 auto; minWidth:0; overflowWrap:anywhere` so it wraps
within the panel (breaking long unbroken tokens). Gutters stay `flexShrink:0` and
keep the **default `align-items: stretch`** so the gutter (and its right border)
spans the full wrapped-row height while the number renders at the **top** (first
visual row) — do NOT switch to `align-items: flex-start` (that shrinks the gutter
to one line, leaving a short border on wrapped rows).

**Regression check:** open a diff/raw file whose hunk mixes short lines with a line
that overflows the panel. With Wrap off, line numbers form one column and the long
line scrolls horizontally. Toggle Wrap on: the long line soft-wraps within the
panel, line numbers stay in the same column anchored at each line's first visual
row, and the choice persists across files and restarts.

## Worktree awareness: one selection owner + worktree-parametrized reads

**Invariant (shared selection):** Per-project `(worktrees, activeWorktree)` has
exactly **one** authoritative owner — `worktreeStore`
(`src/renderer/worktree/worktreeStore.ts`, `useWorktreeStore`/`useActiveWorktree`).
The Changes panel and the Explorer are **pure consumers**; neither owns the other's
worktree state. `changesStore` no longer holds `worktrees`/`activeWorktree` — its
`refresh()` reads the active worktree from `worktreeStore`. Orchestration is
centralized in `panelDataSync` (load/clear/evict off per-session status; a
`worktreeStore.subscribe` seam fires `changesStore.refresh` on an `activeWorktree`
transition — the initial connect is a `null→path` transition, so `loadProject` does
NOT also refresh, avoiding a double refresh). A worktree **switch** is detected via
`changeset.worktree !== activeWorktree` (the provider stamps `changeset.worktree`
with the exact path passed in), which clears stale files before reload; a
same-worktree watch refresh keeps last-good (no flicker). Do NOT reintroduce a
per-panel worktree, route cross-store orchestration through a component/store action,
or add a second worktree "truth".

**Invariant (reads):** The file-read surface is uniformly worktree-parametrized,
base = `worktreePath || projectRoot`, across BOTH transports. `FileReadOptions`
carries `worktreePath?`; `listDir(dirPath, worktreePath?)` takes it positionally
(`src/shared/providers/types.ts`), threaded through `api`, the IPC handlers, and the
**preload bridge**. It is **additive/optional** — an absent worktree behaves exactly
as before, so a version-skewed helper/renderer degrades to root-relative reads rather
than erroring. Local (`localReadFile`/`localListDir`) resolves against
`worktreePath || rootPath`, and `getDiffBundle` reads **both** content sides from the
worktree `cwd` (previously local read them from the fixed root — a local/remote
asymmetry now erased). Remote forwards `worktreePath`; the Go helper
(`remote-helper/commands.go`) resolves relative targets against it (falling back to
`remotePath`), and ref reads run in `cwd: base` so a linked worktree on another branch
reads that branch's HEAD. The renderer read call-sites MUST pass the selection's
`worktreePath`: `ContentViewer` (rendered), `RawFile`, `ImageCompare`, and
`ExplorerPanel` (`listDir` + the file-open selection, which was previously a hardcoded
`''`). Do NOT re-anchor any read to the fixed project root.

**Known follow-up:** link resolution (`openLinkTarget`/`resolvePath`) is NOT yet
worktree-aware (still resolves in-project links against the project root); tracked as
a deferred bead. Full design + regression check:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Worktree-Aware Reads & Shared Selection".

**Regression check:** add a linked worktree on a branch that adds a file absent from
the primary worktree, select it in Changes → the Explorer must list that worktree and
follow the shared selection, and opening the branch-only file must show its content
(no "File not found") with diff-highlight content matching the worktree — on BOTH
local and remote. The primary worktree (or none) must read from the project root
exactly as before. Covered by the linked-worktree case in `local.test.ts`, the
`remote-helper` `*WorktreePath` Go tests, and `worktreeStore.test.ts`.

## Native modules on Electron 42: `cpu-features` is stripped post-install

**Invariant:** A `postinstall` (`scripts/strip-cpu-features.mjs`) deletes
`node_modules/cpu-features` after every install. `cpu-features` is a transitive
**optional** dependency of `ssh2` (it detects AES-NI etc. to pick faster crypto)
that calls `v8::External::New` with the pre-V8-13.6 **two-argument** signature —
in its own `binding.cc` and via `nan` (2.28 still ships the old signature) — so it
**fails to compile on Electron 42 (V8 13.6)** and aborts `electron-builder`'s
native rebuild, even though every REQUIRED native (`better-sqlite3`, `node-pty`)
builds cleanly. `ssh2` guards `require('cpu-features')` in a try/catch and falls
back to pure-JS / OpenSSL crypto, so removing it is functionally safe (only a
crypto micro-optimization is lost). Do NOT remove the postinstall or re-add
cpu-features until it (or `nan`) ships V8-13.6 support.

**Do NOT** "fix" this with `.npmrc omit=optional` — that would also drop
`fsevents` (the macOS file-watch backend). The strip must be cpu-features-specific.

**Playwright CAN drive Electron 42 as of Playwright 1.61.1** (was broken on
1.60/early-1.61: `_electron.launch` reached `firstWindow` but timed out). Verified
2026-07-07: `electron.launch` + `firstWindow` succeed against `out/main/index.js`
under Electron 42.5.1, and a full renderer smoke test drives the real UI (add a
local project via `window.api`, click `.dv-tab`s, read/interact with panels). The
`scripts/screenshots/*` harnesses and ad-hoc Playwright smoke scripts work again —
use them to verify renderer changes end-to-end. (Dockview tabs are `.dv-tab`
elements with **no ARIA role**, so target them by text via
`locator('.dv-tab', { hasText: '<Title>' })`, not `getByRole('tab')`.) If a future
Playwright/Electron bump regresses this, it resurfaces as a `firstWindow` hang.

**Regression check:** after `npm install`, `node_modules/cpu-features` must be
absent; `npm run package:dir` must rebuild `better-sqlite3` + `node-pty` and
produce an app bundle without a cpu-features compile error; the app must launch
under Electron 42 (`electron out/main/index.js`) without a native-load crash.

## `package:*` scripts rewrite (clobber) the source `package.json`

**Invariant:** The packaging scripts (`package`, `package:mac`, `package:linux`,
`package:dir`) invoke electron-builder with
`-c.extraMetadata.version="$(node scripts/release-version.mjs)"`. Because the app
directory is the repo root, electron-builder writes the **effective, minified**
production `package.json` back over the **source** working-tree file: it injects
the release version (e.g. `0.1.0` → `0.1.15`) AND **strips `scripts` and
`devDependencies`** (and drops the trailing newline). This is a real,
reproducible mutation of a tracked file — not a code change — so it shows up as
`M package.json` after any `npm run package*` and, if committed unnoticed, deletes
every npm script and dev dependency from the repo.

**Required:** treat the packaging scripts as tree-dirtying. After running any
`package*` script, **restore the file**: `git checkout -- package.json` (the
version bump belongs only in the built artifact via `extraMetadata`, never in
source). Never `git add -A` / `git commit -a` blindly after a package build —
stage intended paths explicitly. The same builds can also leave stray
asar-extract output (e.g. a root-level `index.js`) if you extracted from
`app.asar` during verification; delete those too.

**Regression check:** run `npm run package:dir`, then `git status --short` — it
lists `M package.json` with `scripts`/`devDependencies` removed; `git checkout --
package.json` returns the tree to clean (`node -e "const p=require('./package.json');
p.scripts && p.devDependencies"` truthy again). No packaging run should ever be
committed with a modified `package.json`.

## Known upstream noise

Radix Select (`@radix-ui/react-select` 2.2.6, latest as of writing) logs
`Warning: Each child in a list should have a unique "key" prop. Check the
render method of Select.` for every Select rendered in the Preferences dialog.
The cause is inside the hidden form-support `BubbleSelect` in the Radix bundle:
it passes a literal 2-element JSX children array (`[option-or-null,
Array.from(nativeOptionsSet)]`) without keys on either element. This is not
fixable at our layer; our `src/renderer/ui/Select.tsx` already de-dupes and
keys its visible options. Treat it as upstream noise until Radix patches it.

## Known issue: control-mode tight-split ghost `%`

Tracked as `local_repo_explorer-7ah9` (P4, won't-fix-for-now).

In the control-mode terminal panel, dragging a split separator small enough
that one pane is roughly the width of the prompt produces zsh's `%`
missing-newline marker on the next prompt. Root cause is independent
rounding by three layers — React flex (pixel weights), xterm.js FitAddon
(`floor((pane_px − ~22px chrome) / cellW)`), and tmux (cells divided by
layout ratios with its own rounding). At normal pane sizes these agree
within ±1 cell (invisible); at tight pane sizes ±1 cell is the prompt's
worth of width, and the wrap exposes the `%`.

Every compensating push strategy explored either drifts the same way
under `floor()`, self-loops when triggered by tmux's layout-change ack
(tmux normalizes pane sizes slightly differently each iteration so `===`
dedupe doesn't catch it), or fires before xterm refits and pushes stale
`term.cols`. Per-pane `resize-pane -x N -y M` after each fit would
side-step it but adds cascade risk + IPC chatter on every drag. The
current state (`pushClientSize` on host RO / cold-start / font / structural
commands, with `clientCells` summing live `term.cols` + tmux separators)
is the best stable compromise.

Mitigation: resizing the panel/window forces a clean `pushClientSize`
through the host ResizeObserver and clears the ghost.

