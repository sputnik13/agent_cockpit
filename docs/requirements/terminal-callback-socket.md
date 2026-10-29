<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=requirements_breakout -->

# Terminal Callback Socket and `cockpit open` — Requirements

## Summary

A process running in a cockpit terminal pane — a user, or an agent — runs
`"$COCKPIT_CLI" open <path>` and that file opens as a tab in the Content panel of
the pane's own project. It works for local and remote projects on every terminal
backend that is in scope. The channel behind it is a general, versioned **callback
socket** (terminal → app) with a default-deny operation allowlist, not an "open"
socket, so later operations reuse it; `open` is the only operation.

This breakout holds the binding requirements and constraints, numbered so the code
and the other documents can cite them ("requirement 12"). The master entries are
FR-15 and NFR-7 in [docs/REQUIREMENTS.md](../REQUIREMENTS.md). The structure is in
[docs/ARCHITECTURE.md](../ARCHITECTURE.md) ("Terminal Callback Socket"), the
implementation detail in [docs/design/terminal-callback-socket.md](../design/terminal-callback-socket.md)
and the verification in [docs/test/terminal-callback-socket.md](../test/terminal-callback-socket.md).

## Objective

Let a user (or an agent) run `"$COCKPIT_CLI" open <path>` inside a cockpit terminal
pane — local or remote, on both the tmux and the cockpit-mux backends — and have
the file open as a tab in the Content panel of the pane's own project, reusing the
existing tab identity (the fully-qualified path, including the worktree).

Decisions that frame everything below:

- One protocol for local and remote: a per-project unix socket whose path is
  injected into the terminal environment at terminal creation.
- The directory is `callback/` and the variable `COCKPIT_CALLBACK_SOCK`; "open"
  appears only as an operation name.
- The CLI is a multi-call mode of the existing Go remote-helper binary
  (`cockpit`), so a remote host needs no new provisioning; the same Go source is
  built for the local host.
- Identity is the project (the socket path) plus the pane (a `pane` field). It is an
  **identity, not a secret**: access control is the socket's filesystem
  permissions alone. This removes secret machinery (HMAC, install secrets,
  rotation) and makes per-pane identity cheap: tmux already puts `TMUX_PANE` in
  every pane's environment, and the mux uses an app-chosen key.

## Scope

In scope:

- A callback listener per live project: in main for local projects, in the
  per-project remote helper for remote projects, both ending in the same renderer
  event.
- Environment injection (`COCKPIT_CALLBACK_SOCK`, `COCKPIT_CALLBACK_VERSION` = the
  callback protocol version, `COCKPIT_CLI` = the absolute path of the CLI, and for
  the mux `COCKPIT_CALLBACK_MUX_KEY`) on every terminal-creation path of the
  in-scope backends: control-mode tmux (local and remote), local session-per-tab
  tmux, and cockpit-mux (local and remote), including window and pane splits and
  the reserved windows.
- The `cockpit` CLI with one subcommand, `open <path>`.
- One versioned request/reply envelope with an allowlisted operation set (`open`
  only) and typed errors.
- Main-side classification of a path into a `ContentSelection`, the renderer event,
  and showing the Content panel without stealing keyboard focus from the terminal.

Out of scope, and documented limitations:

- Operations other than `open` (`review`, `focus`, `notify`) and the MCP server; per-window
  worktree awareness. Any operation that mutates repository, terminal or app state
  needs its own authorization design before it uses this channel.
- `:line` targets (the viewer has no scroll-to-line contract).
- Windows named pipes; macOS and Linux only.
- Switching the active project, or making the Content panel visible for a
  non-active project: an `open` for a non-active project only records the tab in that
  project's slice.
- Verifying that the file exists before replying (the viewer shows its own
  not-found state).
- Retrofitting variables into shells that are already running.
- **Remote session-per-tab** terminals: that backend types `tmux … new-session -A`
  into an interactive shell, so every app-created pane is either the first pane of a
  new session or an existing pane, and a post-hoc `set-environment` has no ordering
  point. `COCKPIT_CLI` is absent there, so `"$COCKPIT_CLI" open …` fails in the shell
  with "command not found" (the CLI never runs, so no exit-3 message);
  `"${COCKPIT_CLI:?cockpit callback unavailable}" open …` is the documented form that
  prints an explanation.
- **Panes created by the in-pane cockpit-mux commands** (`window new`, `pane split`
  of the `cockpit-mux` binary): the daemon spawns them with the daemon's own
  environment, shared by every project on the host, with no app-chosen key. They lack
  the variables.
- **The first pane of a brand-new remote control-mode session**: it exists before
  main can set the session environment, so it lacks the variables until a new tab is
  opened (requirement 6).
- **Installs that use shared session names** (`deterministicSessionNames`): see
  requirement 12.
- A bare `cockpit` command: the app does not inject `PATH`; the guaranteed handle is
  `COCKPIT_CLI`, which locally contains a space (the default macOS profile path does),
  so the documented and tested form is the quoted `"$COCKPIT_CLI" open <path>`.

## Requirements

1. **Terminal → app only, default-deny.** The listener accepts only allowlisted
   operations; an unknown operation returns `unsupported-op`. The allowlist is
   `open`.

2. **Access control is the filesystem.** The socket directory is mode 0700 (verified
   by `lstat`: a real directory, owned by the current user, no group or other bits —
   otherwise the project's callback fails closed) and the socket is explicitly
   `chmod`ed 0600 after bind (Node creates it 0755 under the umask; the 0700
   directory is the real barrier). On Linux the Go listener also checks the peer UID
   with `SO_PEERCRED` and fails closed; there is no peer-UID check in Node on the
   local listener (no API; no native addon is added). Identity values are not
   secrets and are not protected from any process of the same user, who could equally
   drive the app another way. This is the stated trust boundary.

3. **Identity.** A request carries `pane: {kind, id}` read by the CLI from the pane's
   environment: `{kind:'tmux', id: $TMUX_PANE}` (tmux sets it in every pane, including
   windows and splits created later) or `{kind:'mux', id: $COCKPIT_CALLBACK_MUX_KEY}`,
   which **wins when present** (an app launched from a tmux pane makes its mux daemon
   inherit a stale `TMUX_PANE`; the key is the app-chosen terminal key the mux manager
   already passes to `session.create`, injected as an `env` operand at all three
   creation sites). The **project** is the one that owns the socket the request
   arrived on; a request can never name another project. Main treats `pane` as
   attribution metadata (recorded for diagnostics and for later operations); `open`
   needs only the project. A missing `pane` is accepted. Main cannot verify `pane`, so
   a future operation that depends on it must first check that a tmux `%N` belongs to
   one of the receiving project's sessions and that a mux key belongs to that project's
   manager. Main also refuses requests while the project's `ConnectionMachine` status
   is not `connected`.

4. **Stable, short per-project socket path.** `<h>` is the first 12 hex characters of
   SHA-256(projectId). Local: `<userData>/callback/<h>.sock` (the default macOS profile
   path contains spaces, which unix sockets and argv handle). If the path would exceed
   the 90-byte guard (counted in bytes; the same guard the mux socket uses) or could not
   be injected into an environment (a NUL or line break in the `userData` path,
   requirement 6), the fallback is the literal `/tmp/ac-cb-<uid>/<h'>.sock`, its
   directory `lstat`-verified as in requirement 2. For the fallback `<h'>` is the hash
   of the resolved `userData` path **plus** the projectId, because isolated runs
   (`userData` under `tmpdir()`) and long usernames always land on the fallback and two
   profiles that share a projectId (a copied `store.db`) must never share a socket under
   newest-wins takeover. Remote: under `$XDG_RUNTIME_DIR/agent-cockpit/callback/` when
   set, otherwise `~/.agent-cockpit/callback/`, with the file named `<hosthash>-<h>.sock`
   (`<hosthash>` = the first 8 hex characters of SHA-256 of the host name, because a
   remote home may be shared over NFS between hosts). The helper takes no launch
   arguments, so main sends the `projectId` in the handshake and the helper returns the
   absolute `callbackSock` and `cliPath`. A remote path past the guard never disables
   the feature: the helper falls back to a short per-uid directory on the host
   (`/tmp/ac-cb-<uid>/<hosthash>-<h>.sock`, `lstat`-verified) and returns the real path
   in the handshake, so the location of the socket never matters to the CLI.

5. **Listener lifetime mirrors the session-owned watch.** Started when the project's
   session reaches `connected` (local: with the session; remote: by the helper after the
   handshake), stopped on `disconnected`/`failed` and on eviction. Liveness is lazy, so a
   project whose session has not been activated since app start has no listener; the CLI
   then reports not-connected. Takeover: the **newest listener for a project always wins
   the path unconditionally** — the new owner binds a uniquely named random temporary path
   (a fixed temp name would let an old listener's close unlink it) and `rename`s it over
   the real one, so a stale predecessor (a helper left alive by a half-open ssh drop; the
   helper exits only on stdin EOF and the app has no ssh keepalive) cannot hold the path
   and cannot be reached by new CLI calls. Every owner unlinks on close only if the path's
   inode is still its own (Go: `SetUnlinkOnClose(false)` plus an inode check; Node: inode
   check before `unlink`; check-then-unlink is best-effort with a tiny residual window,
   which is accepted). The app does not sweep leftover fallback socket files after a
   crash: a restarted app's listener replaces its own project's file through the takeover
   rename, and a file left by a profile that never runs again stays (a socket inode with
   nothing behind it). Nothing removes the shared `/tmp/ac-cb-<uid>/` directory; the live
   acceptance harness removes only its own run's socket files. A helper that loses its RPC
   stream also closes its listener.

6. **Injection reaches the pane on every in-scope path, never through a typed shell
   command.** Variables are applied by a mechanism that actually reaches the pane process
   (design: "Environment injection"): a tmux pane inherits its **session** environment,
   never the attaching client's. Values are passed as argv or tmux command arguments with
   proper quoting, never restricted by charset (spaces are legal), and are rejected only
   if they contain NUL or a line break. Every tmux command used to apply them is issued
   with an explicit target project: main resolves that exact live session (and fails if it
   is gone) instead of whichever project is ambiently active at the moment the command runs.
   The first pane of a **brand-new** remote control-mode session exists before main can set
   the session environment; the shipped behavior is to accept that limitation until a new
   tab is opened (the choice is one swappable function; see the design breakout).

7. **No ambient contamination.** At startup, before any spawn and **unconditionally**,
   main removes `COCKPIT_CALLBACK_*` and `COCKPIT_CLI` from `process.env` (the app is
   routinely launched from inside a cockpit pane; without this its panes and its persistent
   mux daemon would point at the outer app, including when `deterministicSessionNames` is
   on). It does **not** touch `COCKPIT_MUX_HOME`, `COCKPIT_MUX_BIN` or
   `COCKPIT_MUX_EPHEMERAL`, which are deliberate isolation overrides. Values for a project
   are added explicitly to each spawn's environment, never to `process.env`. The process
   that starts a shared tmux server (`start-server`) is spawned without them — the local
   session-per-tab opener starts the server in its own spawn, as the local control-mode
   opener does — **and also in isolated/ephemeral runs** (`AC_TMUX_EPHEMERAL=1`). An
   ephemeral server must not exit when its last session goes: under `exit-empty on` a
   variable-free server exits at once and the next client, which carries one project's
   variables, would start the server and stamp them into every project's panes. There is no
   safe synchronization point for turning `exit-empty on` later (the `-CC`/node-pty client
   attaches asynchronously, and `exit-empty on` with zero sessions kills the server
   immediately), so **`exit-empty` is `off` in every opener**; an ephemeral run is cleaned up
   by an explicit `kill-server` at quit (a crash leaves the server alive either way, because
   live panes keep sessions). Shadowing by `update-environment` is the second line of
   defense, not the primary one.

8. **Remote reply path.** The helper forwards a request to main as a `callback` event and
   main answers with a `callback.reply` helper RPC; the helper replies to the CLI. The
   helper's read loop was also its executor, so a slow `beadsExec`/diff/status blocked
   reading the next frame; the helper is therefore a reader goroutine that answers
   `callback.reply` itself and a single worker that runs all existing methods in arrival
   order through an **unbounded** queue (the reader never blocks; existing behavior and
   ordering are unchanged). Main replies `dispatched` immediately after its cheap checks
   (allowlist, rate limit, connection status, bounds), then classifies the path
   **asynchronously** (a classification failure after `dispatched` is logged with a
   diagnostics entry and opens nothing) — classification must not sit on the reply path
   because its RPCs (`listWorktrees`) queue behind slow helper methods. The helper caps
   concurrent CLI connections (16) and enforces the frame cap and read deadline itself, and
   its forward timeout (4 s) is shorter than the CLI's 5 s deadline so `timeout` can reach
   the user. A `timeout` reply means "no confirmation", not "the tab did not open".

9. **No second connection truth.** Callback traffic does not feed the `ConnectionMachine`;
   it only reads the session's existing status.

10. **Bounded input and no hangs.** Frames are length-prefixed with a 64 KiB cap, one
    request per connection, a 5 s read deadline on the listener and a 5 s overall deadline
    in the CLI, a `maxConnections` cap (32) on main's listener, where a connection past the
    cap is dropped without a reply and the CLI exits 3 (16 on the helper's, which answers
    such a connection `rate-limited` so the CLI exits 4), and a per-project burst limit
    (10 requests/s) returning `rate-limited`.

11. **Persisted-data continuity.** The persisted tab format is unchanged. The feature adds
    no persisted secret and no migration.

12. **Shared session names disable the feature.** `deterministicSessionNames` exists so
    different machines and installs share one tmux session, so the socket written by
    whichever client attached last would make panes open files in another install's app.
    The decision uses the value that **named the session being attached**, stored with the
    object that names it, never a later live settings read. Remote and local session-per-tab
    resolve the name once at provider construction; the local control-mode manager is
    created lazily from a settings read and is discarded and rebuilt on close and on
    eviction while the provider stays alive, so the gate for control-mode is the value
    captured on each manager at its creation (the same read that chose its session name). If
    the setting is off now but a shared session is live, that session is still never written
    to, including after a toggle followed by a control-mode close and reopen. While
    disabled, the install does no injection, sets no `update-environment` entry of its own
    (so it enables no stripping) and records a diagnostics note; the variable is absent and
    the documented `"${COCKPIT_CLI:?…}"` form explains why. With the setting off, session
    names embed the project id, so installs do not share sessions unless they share a
    project id (a copied `store.db`, or dev and packaged builds on the default local
    socket); that residual case is the same-user risk accepted in requirement 2. Mux
    sessions are namespaced by the raw project id, not by the session-name setting, so mux
    injection stays on regardless of this gate. The startup scrub (requirement 7) is not
    affected by the gate. (`update-environment` is a server-global option: an entry that a
    non-gated object set earlier on the same server, this install's own or another's, still
    applies to a gated object's attaches, whose variable-less client then strips the
    callback variables of the session it attaches, leaving tmux's `-COCKPIT_*` removal
    markers. That is accepted: this app never puts values into a shared session, so at most
    a stale value that something else set there is removed.)

13. **Desktop behavior unchanged when unused.** With no `cockpit` invocation the only
    observable changes are the extra environment variables, a local-only
    `update-environment` entry, and one idle listener per live project. The
    `update-environment` entry preserves tmux's defaults (`SSH_AUTH_SOCK`, `DISPLAY`, …) and
    does not grow across opens: it is applied as **one indexed element per variable name**
    (`set -g 'update-environment[100]' COCKPIT_CALLBACK_SOCK`, `[101]`
    `COCKPIT_CALLBACK_VERSION`, `[102]` `COCKPIT_CLI` — an element holds exactly one name; a
    space-separated value would be stored as one literal name and match nothing), all last in
    the option chain (a failing command stops the rest of a tmux `;` chain on old tmux),
    never as a plain `set -g` and never as repeated `-ga`. (`COCKPIT_CALLBACK_MUX_KEY` is
    mux-only and does not go through tmux.)

14. **Path classification is canonical and uses no remote realpath.** The CLI runs on the
    provider's host and sends both the logical absolute path and its canonical form
    (`EvalSymlinks` of the **parent directory** joined with the base name, so a symlinked
    file inside a worktree is not misclassified as external). Main matches the canonical
    path against the canonical worktree roots from `listWorktrees` (plus the project root),
    builds the selection from the **canonical worktree path plus the relative path** (for a
    match against the project root with no worktrees — a non-git folder — `worktreePath` is
    `''` and the path is relative to the root, as the Explorer builds it; a symlinked remote
    `remotePath` cannot be canonicalized without a realpath RPC, so such a path is classified
    as external on remote, a documented limitation) — the same inputs the Explorer uses, so
    the tab id equals the Explorer's for the same file — and for a path outside every worktree
    builds an `external-file` selection with the logical absolute path. A callback selection
    never carries a `baseline`: a plain file open must not force a git-ref read, which would
    falsely report a never-committed file as missing.

## Accepted risks

- `open` causes a file read **for display** through the provider read path, but it lets any
  same-user process in a pane put any file readable by that user on screen (for example key
  files under `~/.ssh`), and it exposes the renderer's parsers (Markdown with raw HTML,
  mermaid, graphviz, CSV, images) to such processes without a user gesture. There is no
  external-file read policy (`localReadFile` reads any absolute path). This is accepted
  because the caller already has the user's privileges, and recorded so a future operation
  does not inherit the assumption.
- Because identity is not a secret, any future operation that mutates state needs its own
  authorization design (expiring or per-pane secrets) before it uses this channel.
- Spamming is bounded by the per-project rate limit; a tab-count cap is deferred.

## Acceptance Criteria

- In a local pane on each in-scope backend, `"$COCKPIT_CLI" open ./README.md` opens or
  activates the tab for that file in the pane's project; running it again activates the same
  tab rather than adding one. The tab label is the file name and its hover shows the full path
  including the worktree.
- The same holds in a remote control-mode or mux pane, with the project's own helper serving
  the socket (the first pane of a brand-new remote control-mode session is a documented
  exception).
- With two projects on one host (local or remote), `cockpit open` in project A's pane never
  opens a tab in project B, and the reverse, including when the tmux server was started by the
  other project and in the isolated/ephemeral harness.
- A path inside a linked worktree opens with that worktree in its tab identity, including when
  reached through a symlinked path; a path outside the project opens as an external file.
- With the project disconnected or its listener absent, the CLI exits non-zero within 5 s with
  a clear message, including after a half-open ssh drop and helper reconnect.
- A request whose environment names a stale or missing socket fails with not-connected and
  produces no UI change.
- After an app restart with the tmux server and mux daemon alive, a pane of a project whose
  session has been re-activated still works; a not-yet-activated background project reports
  not-connected until activated.
- Launching the app from inside a cockpit pane does not make its own panes call back into the
  outer app.

## Decisions

- Out-of-project paths open as `external-file`; `open` does not switch the active project and
  does not reveal the panel for a non-active project; there is no existence check; `:line` is
  out of scope; identity is not a secret.
- "Show the Content panel" never activates a panel group (so no focus is moved, no focus
  memory is written and the activation guard is untouched). It is declined — with the tab
  recorded, a log line and a status-bar cue with a Show action — when it would hide the
  Terminal, change the group in use or leave a maximized group, or when a closed Content panel
  cannot be added without resizing the terminal. A closed Content panel is re-added inactive
  under Changes, else at the right edge, with the terminal group pinned so it is never resized.
  The options not adopted are recorded in [docs/ARCHITECTURE.md](../ARCHITECTURE.md).
- The first pane of a brand-new remote control-mode session lacks the variables (the shipped
  default). Adopting the initial window as the reserved `persistent` window, or a
  `respawn-pane -k` of the fresh pane, are the recorded alternatives; either is a one-function
  change.
