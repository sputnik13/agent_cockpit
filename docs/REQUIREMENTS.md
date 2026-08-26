<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=requirements -->

# Requirements

## Objective

Provide a lightweight Electron desktop **agent cockpit** for driving a CLI
coding agent against a single active repository — local or remote over SSH —
while watching the work through first-class review surfaces. A
terminal running the agent is a first-class center surface, peer to the content
viewer, with the beads workgraph, change list, diff/preview content viewer, and
notes as read-only observers. The agent in the terminal performs every
repository write, and the surfaces are read-only projections sourced through a
transport-agnostic provider seam — with one exception: the beads **task detail**
surface mutates issue state through the `br` CLI (see NFR-2).

## Scope

In scope:

- Two operating modes behind one workspace-provider abstraction: **Local**
  (filesystem) and **Remote** (SSH).
- An embedded `xterm.js` terminal as a first-class, dockable center surface
  running an interactive CLI agent harness. Both local and remote terminals run
  inside `tmux` on a dedicated `agent-cockpit` socket so sessions persist across
  restarts; local attaches via `node-pty`, remote over an SSH PTY shell. Two
  terminal backends ship and are selectable in Preferences
  (`terminalBackend`): the default **session-per-tab** model (one tmux session
  per terminal tab) and **tmux control mode (`-CC`)** (one per-project control
  connection where tmux is the source of truth for windows↔tabs and
  panes↔splits, with native xterm scrollback per pane).
- A per-project **Run panel**: a saved run command (e.g. `npm run dev`) executed
  in its own persistent `tmux` tty (the `agent-cockpit-run-<projectId>` session),
  with Run/Stop controls. It is a peer of the terminal in the left column.
- A **Sessions panel** listing the `tmux` sessions on the cockpit socket, with
  manual attach and kill/cleanup of detached or orphaned sessions.
- A **static-binary remote helper** (Go), auto-provisioned over SSH/SFTP on
  first connect, serving a narrow read RPC (file read, stat, git
  status/diff/worktrees, beads read, fs-watch) over the SSH channel — no bulk
  transfer or filesystem mount.
- A top horizontal **project tab strip**: exactly one active project visible at
  a time; user-controlled drag reordering (persisted), `Cmd/Ctrl+1..9` switching
  by tab position, and a Manage Projects dialog for deliberate removal. Multiple
  background sessions stay fully live: a backgrounded project's data keeps
  updating so a return is instant, with no warm/hot distinction.
- A Dockview workspace, themed to the shell, with two curated presets (**Edit**
  and **Review**) and a flip action; per-project layout persistence.
- Review surfaces carried forward from v1 and re-homed on the
  provider seam: beads workgraph, changes list, content viewer (unified diff,
  rendered Markdown with changed-block callouts, Mermaid, raw, image-compare),
  task detail, notes, since-seen. All are read-only except **task detail**, which
  mutates beads issue state via the `br` CLI (close/reopen/comment/create — NFR-2).
- A renderer visual system: Tailwind v4 token layer, app-owned primitives, and
  Radix controls.

Out of scope:

- Multiple simultaneous diff/preview pairs beyond the single active content
  viewer.
- Editing files in-app (the agent edits; the app observes).
- Direct writes to the working tree or the beads SQLite DB (the app's only
  repository mutation is beads issue state through the `br` CLI, from task detail;
  the workgraph navigation views stay read-only — see NFR-2).
- Remote helper auto-update / version negotiation beyond one pinned protocol
  version with a hard-fail mismatch (which triggers a single re-provision).
- Windows remote-host support (the client may run on macOS/Linux; remote hosts
  are assumed POSIX with `tmux` available).

## Functional Requirements

- **FR-1 Projects.** A project is a named connection to a repository: `local`
  (a filesystem path) or `remote` (SSH host/user/port/identity + remote path).
  Projects are remembered in app-local SQLite and listed in a top tab strip with
  a type and connection-state badge, in a user-controlled (drag-reorderable,
  persisted) order, switchable by `Cmd/Ctrl+1..9`. Removing a project (via the
  Manage Projects dialog) never mutates the repository or remote host.
- **FR-2 Active project.** Exactly one project is active/visible at a time.
  Switching projects swaps the whole workspace context (terminal, views,
  layout).
- **FR-3 Background-live sessions.** Multiple projects may hold live sessions
  (local PTY, or remote SSH+tmux). A backgrounded session stays **fully live** —
  its terminal, watch, and helper RPC keep running and its Changes/Workgraph data
  stays current — so switching to an already-connected project shows its current
  data immediately with no fetch-on-switch spinner and never another project's
  data. A session ends only by explicit kill or remote idle aging-out, not by
  losing focus.
- **FR-4 Terminal.** Each active project exposes one or more interactive
  terminals bound to the project's working directory, suitable for running a CLI
  agent harness. Two backends are supported and selectable in Preferences via
  the `terminalBackend` setting:
  - **session-per-tab** (default): each terminal tab is its own persistent
    `tmux` session (`agent-cockpit-terminal-<projectId>-<key>`) on the
    dedicated socket, so it survives IDE restarts; local attaches via
    `node-pty`, remote over an SSH PTY shell.
  - **control mode (`-CC`)**: one per-project control connection (`tmux -L
agent-cockpit -CC new-session -A -s agent-cockpit-<projectId>`) is the
    authority for the project's windows and panes; tmux windows map to UI
    tabs, panes map to splits within a tab, each pane renders through a
    **pluggable renderer** selected by the `terminalRenderer` setting — `dom`
    (default) / `webgl` use xterm.js (with native scrollback), `wterm` uses
    wterm's DOM renderer driven by the libghostty VT core — and pane output is
    seeded on (re)attach with `capture-pane`. Layout, structure, and input changes
    round-trip
    through tmux notifications and commands. A per-pane **zoom** toggle drives
    tmux `resize-pane -Z`, and the view follows tmux's reported visible layout so
    a zoom toggled outside the app (a keybinding or another client) is reflected.
    An opt-in **byobu/screen keybinding** mode (`byobuKeybindings`, default off)
    binds a `Ctrl+a` prefix (z=zoom, n/p=next/previous tab, a=send a literal
    `Ctrl+a`) plus `Shift+Arrow` pane navigation, intercepted before xterm so the
    prefix byte never reaches the pane; the existing ⌘ shortcuts always coexist.
    On Apple Silicon, local `tmux`/shell spawns run native arm64 even when the app's
    process tree was launched under Rosetta translation (detected via
    `sysctl.proc_translated`); server-query calls are unaffected.
    Switching backends is a clean-slate operation that kills every cockpit-socket
    tmux session and re-initializes the terminal panel.
- **FR-5 Terminal resilience (remote).** On an _unexpected_ dropped link or app
  restart, re-attaching reconnects to the same tmux session with scrollback
  intact; the agent process keeps running on the host throughout. In control
  mode, reattach replays windows/panes through tmux notifications and reseeds
  each visible pane via `capture-pane`. A _user-initiated_ disconnect is
  explicit teardown/rebuild (FR-5a): scrollback is not preserved across it.
- **FR-5a Connection state machine.** Each project's connection state is owned
  by a single authoritative state machine in main with guarded transitions
  (`disconnected`/`connecting`/`connected`/`reconnecting`/`failed`); the status
  indicator, terminal, and panels are pure derivations of the emitted status.
  The connection state is user-toggleable for remote projects: clicking the
  status connects when disconnected and disconnects (with confirmation) when
  connected; local projects are always connected and not toggleable. A
  user-initiated disconnect tears down the terminal control session and clears
  panels to an explicit "Disconnected" state; reconnect rebuilds a fresh
  provider (re-running helper provisioning), re-acquires + re-focuses the
  terminal, and reloads panels.
- **FR-6 Beads workgraph.** Detect a beads-backed repo and render its task
  graph (ready/in-progress/blocked, dependencies, selected task detail) as a
  first-class view, sourced through the active provider. The view toggles between
  a flat status-grouped list, a parent-child **tree**, and a focused dependency-
  **graph**, with the choice persisted per project. Double-clicking a tree row
  enters a **focus mode** that prunes to that node's ancestor context path plus
  its full subtree (state filter suspended for full context); a slim focus banner
  shows in both tree and graph views, and the graph auto-anchors on the focused
  node and expands its full reachable subgraph. The per-project state filter and
  focus anchor are persisted (sticky across project switches and app restarts).
  Clicking a related bead in the detail panel selects it; a completed
  (terminal-status) blocker is struck through in the Blocked-by list.
  **Reads** (graph, task) use the direct SQLite/JSONL path; **writes** — close,
  reopen, add comment, create child issue, and list comments — go through the
  `br` CLI via the provider (local `spawnSync`; remote over the helper exec RPC),
  surfaced inline in the task-detail panel with a pending state and `br`'s own
  error message shown inline. `br` is always invoked with an argv array (no
  shell). Writes are supported for both local and remote projects.
- **FR-7 Changeset + content viewer.** Show the live per-worktree changeset vs
  a selected baseline (default `HEAD`); render each file through the uniform
  per-type mode model — **Diff**, **Rendered**, and (text-like types only)
  **Raw** — defaulting to the best mode for the type: unified diff, rendered
  Markdown with changed-block callouts and Mermaid, sandboxed HTML preview,
  image compare/view, highlighted code, or structural folding for JSON/YAML
  (FR-13); binary files degrade to graceful
  placeholders that point at Download. Filtering/search across the change
  list. The rendered-
  Markdown mode is GFM-complete in a single whole-document parse so reference
  link definitions, footnote definitions, and reference images resolve across
  blocks; top-level elements are annotated with their source line range so the
  changed-block callout matches against the live `changedLineSet`. Themed
  prose typography (scoped `.agent-cockpit-markdown`, theme-token driven for
  both Solarized themes), syntax-highlighted fenced code (`rehype-highlight`,
  base16 Solarized), and a safe link/image transform (absolute http(s)/mailto
  anchors open via the platform shell with `target="_blank"` + `rel="noopener
noreferrer"`; relative/fragment/`javascript:` anchors stay inert; only
  http(s)/`data:image/` image sources render) are part of this requirement.
  Bare/inline HTML written directly in Markdown prose also renders (a fenced
  `` ```html `` block still renders as a plain code listing, matching GitHub):
  it is sanitized against `hast-util-sanitize`'s `defaultSchema` (published as
  following GitHub's own Markdown HTML sanitization rules), extended with two
  narrow protocol widenings — `href` gains `file:`, `img[src]` gains
  `data:image/*` — since this app, unlike GitHub, has a local-repository
  focus, plus a `clobberPrefix` override to keep GFM footnote ids/hrefs
  consistent (accepted trade-off; full rationale in ARCHITECTURE.md
  "Untrusted repository content").
  A **find-in-file** affordance (Cmd/Ctrl+F) searches within the currently
  displayed file across the rendered/raw/diff modes: case-insensitive, with a
  match count, next/previous navigation, and highlighted matches that scroll into
  view. It is scoped to the content panel and does not hijack find from a focused
  input or terminal; image mode has no text search.
- **FR-8 Live updates.** File changes propagate to the views via a layered
  filesystem watch subsystem with a single authoritative watch policy
  (`src/shared/watch/policy.ts`). Local transport uses chokidar + `fs.watch`;
  remote transport sends a derived `WatchSpec` over the `watch.subscribe` RPC
  so the Go helper is policy-driven rather than hardcoding its own exclusions.
  All transports emit canonical events through one ingest pipeline and a central
  renderer dispatch hub; panels subscribe by `WatchCategory` interest and never
  re-implement path filtering. On a remote project, `br` flushes, commits, and
  branch switches auto-refresh the Changes and workgraph panels without a manual
  refresh. The Changes list hides `.git` and `.beads` entries by default (display
  concern, not a watch exclusion); a global **"show all changes"** toggle
  (`showAllChanges` in settings) reveals them. Updates are debounced with one
  shared constant, without stealing scroll position.
- **FR-9 Review state.** Mark reviewed files/hunks, leave local notes against
  project/worktree/file/hunk/block/bead, separate "changed now" from "already
  reviewed" (since-seen), export notes as Markdown. Stored app-local only.
- **FR-10 Layout.** Terminal and content viewer are independent dock panels;
  ship two themed presets (Edit, Review); persist and restore layout per project
  and per view, so switching views keeps each view's own layout. The left column
  stacks Workgraph, Task, and Run. The default 3-column layout is proportional to
  the workspace width (`1:3:1`), and a Reset control restores the default at a
  chosen column ratio (`1:3:1`, `1:2:1`, `1:1:1`). Every dockable panel header
  offers a maximize/restore control (Dockview group maximize) that temporarily
  fills the dock area and restores the prior layout.
- **FR-11 Run panel.** Each project has an optional saved run command, persisted
  app-local. The Run panel executes it with Run/Stop controls; the tty stays
  interactive and the process survives IDE restarts.
  - In **session-per-tab** mode, the run command lives in a dedicated
    persistent `tmux` tty (`agent-cockpit-run-<projectId>`, one per project).
    Each tty (terminal tabs and the run tty) offers a reset control that
    reattaches its `tmux` session without killing it, to recover a wedged tty.
  - In **control mode**, the run command targets a distinguished pane within
    the project's control session (typically a `run` window) and gains native
    pane scrollback like any other pane.
    Live terminals belonging to non-active projects are reaped after an idle
    period to bound resource use; the underlying `tmux` session survives so
    returning to the project reattaches it.
- **FR-12 Sessions management.** A management modal (opened from the terminal
  surface) lists the `tmux` sessions on the cockpit socket (name, window count,
  attached state), copies a manual attach command, and kills a session or all
  detached sessions. Covers local-socket sessions for both backends — including
  orphaned per-key sessions left over from prior backend use — so they remain
  manageable. A remote project's host-side sessions are visible only inside its
  terminal.
- **FR-13 Structural folding for JSON/YAML.** JSON (`.json`/`.jsonc`) and
  YAML (`.yaml`/`.yml`) files offer a structural-folding **Rendered** view:
  collapsible objects/arrays/mappings/sequences/block scalars with
  always-visible fold toggles, an "N items" placeholder chip per collapsed
  region, and original source line numbers throughout. Everything rendered is
  the file's literal source text — formatting, comments, key order, number
  precision, and YAML anchors are preserved exactly; folding only hides
  lines, never rewrites them. Multi-document YAML streams render every
  document, stacked with labelled separators; YAML anchor definitions and
  aliases carry small linkage badges with tooltips. Parsing runs off the main
  thread; a file that fails to parse degrades to the plain
  syntax-highlighted view with a visible notice, never a blank pane. Files
  larger than the configurable `structuredFoldMaxMb` threshold (Preferences,
  default 10 MB, bounds 1–100) fall back to the plain syntax-highlighted line
  view with the mode switcher unchanged. This fallback is reachable via a
  dedicated read-cap override: a json/yaml file strictly between the
  threshold (T) and twice the threshold (R = 2T) reads successfully and
  degrades to the plain view; a file above R still refuses (the generic "too
  large to preview inline" placeholder, folding view unchanged) rather than
  degrading — remote additionally clamps R to a 12 MB effective ceiling (a
  frame-size constraint of the remote helper RPC). Diff is unchanged from
  other text-like files; Raw for json/yaml also reads at the same raised cap
  as Rendered (so the two never disagree about whether a given file is
  available to preview at all).

## Non-Functional Requirements

- **NFR-1 Security boundary.** The renderer stays sandboxed
  (`contextIsolation`, no `nodeIntegration`, `sandbox: true`). The terminal,
  PTY/SSH host, provider RPC, and file/process access live in the main process
  behind a narrow, input-validated preload bridge. Repository Markdown/Mermaid
  remain untrusted: Markdown (including bare inline HTML) is sanitized via
  `hast-util-sanitize` and DOMPurify before render; Mermaid/Graphviz compile to
  SVG via a bundled, same-origin library and that SVG output is likewise
  DOMPurify-sanitized before insertion (no iframe — the input is a narrow DSL,
  not arbitrary HTML).
- **NFR-2 Write boundary.** The app writes its app-local SQLite store and — as
  the single repository-mutating exception — beads issue state through the `br`
  CLI (close/reopen/comment/create). That path preserves `br`'s audit trail,
  policy gates, WAL handling, and JSONL sync, is always invoked with an argv array
  (no shell, so issue ids / titles / messages cannot inject), and never writes the
  working tree or the beads SQLite DB directly. All other repository mutation
  happens through the agent inside the terminal, never through app IPC.
  The Download capability adds one bounded, **non-repository** write: at
  explicit user request, a file is copied OUT of the repository to a
  user-chosen destination on the app host (native Save-as dialog in main; no
  file bytes cross IPC); it never writes into the repository, local or remote.
- **NFR-3 Remote footprint.** The only hard remote-host prerequisites are an
  SSH account, `tmux`, and the ability to run the uploaded static helper
  binary. No package manager, language runtime, or root is required.
- **NFR-4 Reconnect.** Remote channels recover from dropped SSH connections
  without blanking the app shell; views show connection state and reconnect
  affordances.
- **NFR-5 Responsiveness.** Per-project data is kept isolated (one `byProject`
  slice per live session) and pushed in from outside React, so a single active
  project's interactions (terminal latency, diff render) stay responsive
  regardless of how many background sessions exist. The live set is bounded by
  explicit kill plus remote idle aging-out (`sessionIdleTimeoutMin`).
- **NFR-6 Untrusted content.** Repository file content is untrusted: large
  files degrade to size/binary notices, Markdown (including bare inline HTML)
  is sanitized, and Mermaid/Graphviz SVG output is sanitized before insertion
  into the same document.

## Workflow

The high-level user loop:

1. Add a project (local path, or remote SSH target + remote path) and activate
   it from the top tab strip.
2. The cockpit connects the project's provider (immediate for local; SSH
   handshake + helper provisioning + tmux attach for remote) and restores that
   project's saved layout.
3. Drive the CLI coding agent in the embedded terminal. The agent performs all
   repository writes.
4. Watch the work through the read-only surfaces: the beads workgraph for task
   context, the changes list + content viewer for what the agent edited, the
   since-seen queue for what changed since the last review pass.
5. Mark reviewed state, leave local notes, and export notes as Markdown for
   handoff back to the agent.
6. Switch projects from the tab strip (or `Cmd/Ctrl+1..9`); only `activeId`
   moves — the outgoing project's session stays fully live (its data keeps
   updating in the background) and the incoming project's already-warm data
   renders immediately.

## External Dependencies

- **Electron** desktop shell (main + preload + sandboxed renderer).
- **React 18 + TypeScript**, built with Vite via `electron-vite`.
- **Dockview** workspace layout system.
- **Tailwind v4** token layer + **Radix** primitives for the visual system.
- **xterm.js** terminal renderer; **node-pty** for the local PTY.
- **ssh2** for the remote SSH transport, SFTP upload, exec, and tmux PTY shell.
- **simple-git**, **chokidar**, **better-sqlite3** for local git/watch/beads
  reads, and the app-local SQLite store.
- **unified / remark / rehype / rehype-raw / rehype-sanitize / rehype-highlight**
  + **DOMPurify** for single-pass sanitized Markdown (including GitHub-style
  sanitized bare inline HTML) with syntax-highlighted fenced code; **mermaid**
  rendered inline as sanitized SVG (no iframe).
- **jsonc-parser** + **yaml** for source-mapped structural folding of
  JSON/YAML in the content viewer's Rendered mode (both zero-runtime-dependency).
- **Go** (`CGO_ENABLED=0` static cross-compile) for the remote helper binary.
- Remote host: SSH account, `tmux`, ability to run the uploaded helper binary.

## Acceptance Criteria

- Adding a local project and a remote project, switching between them, and
  having each show its own terminal, beads graph, and changeset.
- Killing the SSH link mid-agent-run and reconnecting returns to the same tmux
  session with the agent still running and scrollback preserved.
- Editing a file via the agent in the terminal updates the changes list and the
  content viewer for the active project, and does not update an inactive
  project's views.
- On a remote project: a `br` flush, a commit, and a branch switch each
  auto-refresh the Changes panel and the workgraph panel without a manual
  refresh (FR-8 remote transport parity).
- The Changes list hides `.beads` entries by default; enabling "show all
  changes" reveals them (FR-8 surface policy).
- The remote helper is uploaded and launched automatically on first remote
  connect with no manual host-side install beyond tmux.
- Renderer surfaces (shell, rail, Dockview host, panels, controls, rows,
  badges, dialogs, status) are styled through shared roles/components, not
  per-element inline styles.

## Linked Documents

- [docs/DESIGN.md](DESIGN.md) — implementation design, flows, schema, and
  phasing.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — cross-cutting boundaries, topology,
  and ownership.
- [docs/TEST_PLAN.md](TEST_PLAN.md) — test strategy and scope.
