<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=test_breakout -->

# Terminal Callback Socket and `cockpit open` — Test Plan

## Summary

The callback socket is verified in layers: pure unit tests of the wire codec, identity, paths,
broker and injection contracts; integration tests against a real, isolated tmux server and a real
cockpit-mux daemon; Go tests of the remote helper and the `cockpit` CLI; tests that run the real Go
helper, the real CLI and the real broker together (one from a real tmux pane); component tests of the
renderer leg against the real Dockview in jsdom; and a live acceptance suite that drives the BUILT app
with real panes and keystrokes on every local backend. This breakout lists each scenario with its
evidence, describes the live harness, and states plainly what has **not** been executed. Master test
plan: [docs/TEST_PLAN.md](../TEST_PLAN.md). Requirements:
[docs/requirements/terminal-callback-socket.md](../requirements/terminal-callback-socket.md). Design:
[docs/design/terminal-callback-socket.md](../design/terminal-callback-socket.md).

## Strategy

- Every end-to-end scenario uses an isolated tmux socket (with its own `TMUX_TMPDIR`), mux home and
  Electron profile owned by the run, never the user's persistent resources; the tmux scenarios run in the
  ephemeral configuration the harness uses, except the restart scenario, which needs the tmux server and
  mux daemon to outlive an app relaunch and therefore uses a non-ephemeral isolated socket and mux home with
  explicit cleanup.
- Real binaries over mocks wherever the contract is a process boundary: a real tmux (`-L` private socket,
  private `-f` config) for the environment mechanism, a real Go helper over a real socket, the real CLI.
  Fakes are used only where a live counterpart cannot exist in CI (a remote control channel, an SFTP
  server, an old tmux).
- Cross-language contracts are pinned by shared fixture files (`src/shared/callback/fixtures/`) that the
  TypeScript reference and the Go mirror both replay.
- A guard is considered tested only if reverting it fails a test (mutation-checked). The live suite's
  guards were mutation-checked against rebuilt apps (below).

## Scenarios

| #   | Scenario                                                                                                                                                                                                               | Result                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Environment-delivery assumptions: indexed `update-environment`, `TMUX_PANE`, remote `set-environment`, mux operands, multi-call CLI/signing/targets, path lengths, rename takeover                                     | Partly executed (gaps)           |
| 2   | Identity: `pane` read from `TMUX_PANE` or `COCKPIT_CALLBACK_MUX_KEY` (the key wins); project derived from the receiving socket; a request cannot name another; missing `pane` accepted; no secret material             | Verified                         |
| 3   | Wire codec round trip, 64 KiB cap, truncated/oversize/malformed frames, unknown `v`; the Go mirror replays the same fixtures                                                                                           | Verified                         |
| 4   | Broker decision: allowlist, rate limit, `bad-request`, refusal when status is not `connected`, `dispatched` before classification, no renderer event for a rejected request                                            | Verified                         |
| 5   | Socket path: deterministic 12-hex hash, spaces in `userData`, `/tmp` fallback with `lstat` checks failing closed, 0700 directory and 0600 socket, remote host-hash and `$XDG_RUNTIME_DIR` naming and length            | Verified (no live host)          |
| 6   | Listener lifecycle: started on `connected`, closed on `disconnected`/`failed` and eviction, lazy, unlinked on project removal                                                                                          | Verified                         |
| 7   | Takeover: newest listener wins via temporary-path `rename`; a stale predecessor can neither hold the path nor delete the newer socket; a helper that loses its RPC stream closes its listener                          | Verified (no half-open)          |
| 8   | Injection on every opener: local control-mode and session-per-tab (real tmux), local mux (argv at the three call sites and a live daemon), remote control-mode (fake channel); explicit project addressing             | Verified (no live host)          |
| 9   | `update-environment[100..102]`: present, idempotent, defaults kept, last in the chain, absent from the remote shell openers, a variable-less attach strips only callback variables, old-tmux diagnostic                | Verified (emulated old)          |
| 10  | Environment hygiene: the startup scrub is unconditional and keeps the `COCKPIT_MUX_*` overrides; the server-start spawn is variable-free (also when `process.env` is contaminated and in ephemeral mode)               | Verified                         |
| 11  | Shared session names: the gate is the value captured with the naming object; a toggle followed by a control-mode reopen never injects; the scrub still runs                                                            | Verified                         |
| 12  | Path classification: primary root, linked worktree, symlinked path, symlinked file, unrelated tree (external), no `baseline`, tab id equal to the Explorer's, no remote realpath                                       | Verified                         |
| 13  | Remote reply path: forward, `dispatched`, reader/worker split, connection cap, 4 s forward timeout, shutdown mid-request, event registry, handshake extension, pre-handshake `onClient` hook, hash-keyed atomic upload | Verified (no live host)          |
| 14  | CLI exit codes and deadline, canonical-parent resolution, dispatch before `bootstrapPath`, listener frame cap/deadline/slowloris, helper directories and link retargeting, local link, signer                          | Verified (no Linux/notarization) |
| 15  | Main listener read deadline and `maxConnections`; NUL/newline value rejection; tmux quoting of `$ ; ~ #` and spaces                                                                                                    | Verified                         |
| 16  | Renderer leg: a new tab, no duplicate, label and full-path hover, a non-active project records without switching or revealing, keyboard focus stays in the terminal in every Dockview layout                           | Verified (local backends)        |
| 17  | Live: `cockpit open` from a control-mode, a session-per-tab and a mux pane, a split, a new window, in-pane mux commands lacking the variables, two projects never crossing                                             | Verified (local)                 |
| 18  | Live remote host: control-mode and mux with two projects; helper reconnect, half-open drop, `-CC` reattach; first-pane behavior of a brand-new session                                                                 | **Not executed**                 |
| 19  | Restart: relaunch with the tmux server and mux daemon alive; a re-activated project's existing pane works; a not-yet-activated project reports not-connected                                                           | Verified (local)                 |
| 20  | Negative: disconnected project or stale socket exits within 5 s; with `deterministicSessionNames` on, injection is off and the CLI reports not-connected                                                               | Verified (local)                 |
| 21  | Regression: terminal, control-mode, mux, IPC, panel-focus and content-tab suites pass                                                                                                                                  | Verified (see gaps)              |

### Evidence

- **1 (partial).** Run on macOS arm64 with tmux 3.7c, Go 1.27.1 and git 2.56, using isolated `-L` sockets and
  `-f /dev/null`. Verified: `update-environment[N]` is idempotent, leaves the defaults intact, copies client
  variables on create and on `new-session -A` attach, strips them when the client lacks them, and a server started
  by a variable-free process keeps a clean global environment; `TMUX_PANE` and the variables are present in the
  first pane, a later window, a split and after `respawn-pane`; a single Go binary run through a symlink named
  `cockpit` sees its program name and cross-compiles for darwin/arm64, darwin/amd64, linux/amd64 and linux/arm64
  (the helper build script targets only darwin/arm64 among darwin builds); `git worktree list --porcelain`
  reports canonical roots; the temporary-socket-then-`rename` takeover works in Node and in Go; the default
  `userData` path is 85 bytes but a long username pushes it over the 104-byte macOS limit, so the `/tmp` fallback
  is required, not optional; `NAME=value` operands to `/usr/bin/env` deliver values including one with a space.
  Not executed: remote `set-environment` over a real control channel and the first-pane options; the oldest
  supported tmux and git.
- **2, 3, 4, 5, 6, 12, 15.** Unit tests in `src/shared/callback/` and `electron/main/callback/` (identity, codec
  with shared fixtures, broker, socket paths, lifecycle, classification, listener limits) plus the Go mirror's tests.
- **7.** Node and Go: the newest listener wins on a real socket, a stale predecessor is unreachable and its close
  leaves the newer socket, the owner's close unlinks its own, a replaced path is never touched; a helper that loses
  its RPC stream closes its listener and unlinks, in-process over pipes and as a real helper process.
- **8, 9, 10, 11.** Real isolated tmux 3.7c for the local openers (first pane, later window, split, `respawn-pane`; a
  re-attach with different values refreshes the session and a variable-less re-attach strips only the callback
  variables; the three elements are present, idempotent across repeated opens and projects, last in the chain and
  absent from both remote openers); a live local mux daemon on a private mux home plus argv assertions at the three
  call sites; the remote control-mode manager against a fake control channel (ordering before `attached`, bounded
  timeout with the FIFO entry kept, reattach, explicit per-project addressing); the old-tmux diagnostic with a fake
  runner and through the real opener behind a wrapper that reports `tmux 2.6` and rejects the indexed form;
  behavioral tests of the real IPC handlers (every terminal and control-mode attach waits for the session's pending
  listener bind) and of the shared-session gate with the setting flipped between reads.
- **13, 14.** Go tests in-process over pipes with the test acting as main (forward, relayed `dispatched`, edge refusals
  never forwarded, argument validation tables, re-encoded forwarding, the helper burst limit on a fake clock, the
  process-wide `connId`, error text cut on a character boundary, the 4 s forward timeout below the 5 s CLI deadline,
  shutdown mid-request, reply validation, the connection cap with a crowd of peers that never read, the reader/worker
  guarantees: a held slow method does not delay `callback.reply`, arrival order is kept, a 3000-request burst never
  blocks the reader, EOF drains what was accepted, the listener is released first); every CLI exit code, silent
  success, logical `$PWD` (in-process and as a real process in a symlinked directory), the canonical parent-only form,
  a deadline test, dispatch before `bootstrapPath` as a real process with a marker `$SHELL`, the CLI never reading
  stdin; helper directory/link creation with `lstat` checks and an atomic retarget against a concurrent reader. The
  TypeScript side: the `onClient` hook runs before the handshake and sees an event that overtakes the handshake reply;
  the bridge answers through the production broker's decision function gated on the originating project's status;
  provisioning (hash-keyed names, atomic first upload and replacement, `replaceExecutable` against a fake SFTP:
  temporary removed on any failure, remove-then-rename when `posix-rename` is unavailable); `RemoteProvider` wiring and
  teardown through a real `SessionManager`; and tests with the REAL Go helper, the REAL CLI and the real broker, one of
  them from a REAL tmux pane whose session received the helper's values through the shared `set-environment` builder.
  The local link, packaging configuration and the signer's selection and hash refresh are covered; the signer was run,
  and `codesign --verify --strict` passed, on a synthetic bundle.
- **16.** Component level against the REAL Dockview in jsdom (`panelReveal.test.tsx`,
  `callbackOpenWorkspace.test.tsx`, `callbackOpen.test.tsx`, `openCueStore.test.ts`, `statusRegionCue.test.tsx`,
  `appShellCallbackOpen.test.tsx`, and on the main side `rendererForward.test.ts` and `callbackOpenWiring.test.ts`):
  for Content visible in its own group, hidden behind Changes in a non-active group, tabbed behind the Terminal, a
  background tab of the active group or of the group holding the focused element, another group maximized, Content
  itself maximized, closed, and restored from a saved layout — the outcome, that DOM focus stays on the same attached
  element, that Dockview's active panel does not change and that no activation event is emitted; that a plain
  `setActive()` does emit one (the reason the reveal never uses it); that re-adding a closed Content panel never changes
  the terminal's size in the real presets and is declined when there is no room; the persisted focus memory is
  untouched; the status-bar cue and Show; a non-active project records its tab and nothing else; an open for the project
  being switched to is recorded but not revealed in the previous project's layout; payload validation and a main-window
  only send. The live specs below confirm the focus retention with a real shell on the control-mode, session-per-tab and
  mux backends.
- **21 (recorded at closeout).** `npm run typecheck`: clean. `npm run lint`: 24 problems (23 errors, 1 warning), all in
  unrelated files, none added. Full vitest: 174 test files, 2552 tests passed, 31 skipped (the better-sqlite3 ABI suites
  `store/projects` and `store/notes`, and one opt-in live-mux test), 0 failed; under heavy load two timing-sensitive
  tests can time out (the remote-rpc one-byte-frame test, and the real-repository markdown corpus-parity test with its
  30 s limit) and each passes alone. `go vet` and `go test ./...` in `remote-helper`: ok (about 12 s), also vetted and
  test-compiled for linux/amd64 and linux/arm64. `npm run build`: ok. `npm run test:e2e:callback`: 37 passed (6 in
  `callback-open.spec.ts`, 31 in `callback-acceptance.spec.ts`; about 50 s). The existing live checks
  `npm run verify:content-tabs` and `npm run verify:content-modes`: all pass (local). Not run: `npm run test:e2e:mux`
  (needs a packaged app); the cockpit-mux Go suite has one failing test unrelated to this feature (see the gaps).
- **17, 19, 20** are the live suites described next.

## Live acceptance harness

`npm run test:e2e:callback` builds the app and runs two serialized Playwright specs against the BUILT app
(`playwright.callback.config.ts`, one worker):

- `tests/e2e/callback-open.spec.ts`: the renderer leg on the tmux control-mode backend — a real `"$COCKPIT_CLI" open
README.md` typed into the focused terminal adds the tab (label, full-path hover) and the terminal keeps the keyboard
  (the next command typed is run by the shell); a repeat reuses the tab; a closed Content panel is re-added without
  taking focus; with the terminal maximized the open is declined (the keyboard stays, the maximized state is left
  alone) and the status cue's Show exits maximize, shows the file and takes the focus; the real CLI aimed at a
  background project's own socket records its tab there with no switch and no reveal.
- `tests/e2e/callback-acceptance.spec.ts` with `tests/e2e/support/callbackRun.ts`: the integrated acceptance.
  - **Scenario 17.** Session-per-tab (profile path with a space, primary socket location): each pane has its own
    socket, version and CLI link; the shared tmux server keeps a clean global environment and the three indexed
    `update-environment` elements; B's pane created after A started the server opens into B only, and A's new tab
    created after B exists opens into A only; a repeated `./README.md` open reuses the file-name-labelled tab.
    Control-mode (long profile path, `/tmp` fallback location): the pane's values equal its tmux session's, the same
    two-project order, a later window (the + button), a linked worktree (the same relative name in two worktrees is two
    tabs, the worktree is in the identity), a symlinked directory (no new tab), an external file in its logical form,
    and a stale or a missing socket in the environment exiting 3 with no UI change. Cockpit-mux: the root pane's
    `COCKPIT_CALLBACK_MUX_KEY` is its own terminal key; a split (Cmd+D) and a new window (Cmd+T) each get the project's
    socket with a key of their own and open into A; B's pane created after A started the daemon opens into B only; panes
    made by the in-pane `cockpit-mux pane split` / `window new` carry no callback variable and nothing from the outer
    app while the isolation overrides survive, `"$COCKPIT_CLI"` fails in their shell and `${COCKPIT_CLI:?…}` explains.
  - **Scenario 19.** Control-mode with the isolated tmux server alive and cockpit-mux with the isolated daemon alive:
    with the app quit the sockets are gone and a surviving shell reports not-connected within the deadline; after the
    relaunch the same shell (same pid, byte-identical environment) opens into its project once re-activated; a project
    that was not activated has no listener (exit 3) until it is, then works from its surviving pane. Already-running
    shells gain no new variable and need none: the socket path is deterministic. A NEW window (control-mode) or
    split (mux) created after the relaunch has the variables, so the re-attach refreshed the session rather than
    stripped it.
  - **Scenario 20.** With `deterministicSessionNames` on, a real control-mode and a real session-per-tab pane have no
    callback variable (nor the outer app's), the shared server has no `update-environment` entry of ours, the
    diagnostics buffer says why, and the CLI run by the path the app links exits 3 within the deadline naming the
    missing `COCKPIT_CALLBACK_SOCK`; nothing opens. Two running apps with their own profiles and project ids attach to
    ONE tmux session (same shell, no variable, each install's CLI exits 3, nothing opens in either). The assertions
    are about the SESSION, not only the shell that already existed (its environment was fixed when it started): the
    shared session's own environment has no callback variable, the shared server has no callback `update-environment`
    entry, and a NEW window opened through install 2, which inherits the session environment, has none. Mux injection
    stays on under the same setting.
- **Isolation and cleanup.** Each run owns one short directory (`/tmp/ac-e2e-cb-*`) holding its HOME, `TMUX_TMPDIR`
  and tmux socket, mux home, report files and git projects, and — for the runs that use the primary socket location —
  its Electron profile (a path with a space, like the real macOS profile). The runs that exercise the `/tmp` socket
  fallback keep their profile in a separate directory under the OS temp dir (a path too long for the primary location);
  teardown removes it and scans for processes that name it as well. The app is launched with the OUTER
  app's `COCKPIT_CALLBACK_*`/`COCKPIT_CLI` in its environment, so the startup scrub is exercised live. Teardown closes
  the app, shuts the mux daemon down through the app (then by signal), kills the run's tmux server, removes its
  fallback socket files (never the shared `/tmp/ac-cb-<uid>/` directory) and the directory, and then FAILS the run if
  any process, callback socket, pane shell or directory named for it is still present.
- **Reports, not screen scraping.** The environment and the CLI's exit code, duration and stderr of a pane are written
  to files by commands typed into the pane and read back by the test, so assertions never depend on how the terminal
  wraps a long path.

## Mutation checks

Each of these defects, introduced into the source and the app rebuilt, fails the intended live tests and no others of
its kind: a project value in the server-start environment (the server's global environment is no longer clean); a
socket path that changes per app instance (a surviving pane cannot reach the relaunched app); a wrong mux key; a
disabled startup scrub (panes made by the in-pane mux commands inherit the outer app's variables); a disabled
shared-session gate (a gated pane receives variables); a shared-session gate disabled for ONE of two installs sharing a
tmux session (that install's socket lands in the shared session's environment — the shell that already existed still
looks clean, which is why the assertions are about the session); and a classification that ignores the canonical path
(a worktree reached through `/tmp` and a symlinked directory are mis-classified).

## Verification gaps

These are not verified, and should not be read as passing:

- **Live remote host (scenario 18).** The ssh hop, provisioning of the helper build, a reconnect or half-open ssh drop
  during a request, remote tmux and mux panes receiving the variables, the remote control-mode `set-environment` over a
  real channel, a stale helper after a half-open drop, and an NFS-shared home. Everything about the remote path that can
  run without a host is covered (scenarios 8, 9, 13, 14), but no live remote run has been made.
- **The first pane of a brand-new remote control-mode session** lacks the variables (the accepted default; a new tab
  has them). Its behavior on a real host has not been recorded.
- **Linux.** The helper's `SO_PEERCRED` check is compiled for linux/amd64 and linux/arm64 and covered by Linux-only
  tests, but those tests have not been run on a Linux kernel; the whole feature has been exercised on macOS only.
- **A packaged, notarized app.** A real `electron-builder` package, its notarization, and the packaged app launching
  the CLI from `Contents/Resources` have not been run; the signer was run on a synthetic bundle only. An Intel Mac has no
  local CLI (the helper build has no darwin/amd64 target).
- **The old-tmux floor.** The oldest supported tmux is not recorded anywhere, and a genuinely old tmux has not been run:
  the indexed-`update-environment` failure diagnostic is exercised with a fake runner and through the real opener behind
  a wrapper that emulates `tmux 2.6`. The oldest supported remote git for `worktree list` is likewise unchecked.
- **No sweep of leftover fallback sockets after a crash (requirement 5).** The app does not clean up the socket file a
  crashed run leaves under `/tmp/ac-cb-<uid>/`: a restarted app replaces its own project's file through the takeover
  rename, and a file left by a profile that never runs again stays. Only the live harness removes its own run's files
  (and never the shared directory); there is no app behavior to test and none is claimed.
- **No pruning of old remote helper builds.** Each source change leaves one more static helper (about 4 MB) per os/arch
  on a remote host; there is no cleanup, by design (see the design breakout).
- **Layouts and platforms of the reveal.** Drag-and-drop arrangement of the layouts in the live app, floating and popout
  Dockview groups, native window focus (the live specs keep the window hidden and assert DOM focus), and Windows.
- **Pre-existing, unrelated:** the cockpit-mux Go suite has one failing test
  (`TestOperationsAttachSendsLiveGraphicsOnlyToNegotiatedWTerm`) that fails identically without this feature; the
  packaged Playwright mux suite (`npm run test:e2e:mux`) needs a packaged app and was not run for this change.

## Verification environment

Evidence was recorded on macOS arm64 with tmux 3.7c, Go 1.27.1, git 2.56 and the project's Electron 42 and Playwright
versions (`package.json`), against isolated sockets, profiles and mux homes. Run the suites with
`env -u TMUX -u TMUX_PANE AC_TMUX_SOCKET=<unique> npx vitest run`, `cd remote-helper && go vet ./... && go test ./...`,
and `npm run test:e2e:callback`.

## References

- [docs/TEST_PLAN.md](../TEST_PLAN.md) — the master test plan and quality gates.
- [tests/e2e/callback-acceptance.spec.ts](../../tests/e2e/callback-acceptance.spec.ts) and
  [tests/e2e/support/callbackRun.ts](../../tests/e2e/support/callbackRun.ts) — the live acceptance suite.
- [tests/e2e/callback-open.spec.ts](../../tests/e2e/callback-open.spec.ts) — the renderer-leg live spec.
