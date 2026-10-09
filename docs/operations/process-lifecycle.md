<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=operations -->

# Process Lifecycle and Leak Findings

## Scope and outcome

This record covers local `cockpit-mux` processes, PTY shells and their child
helpers, local tmux servers/sessions, Electron/Playwright test processes, and
packaging commands. Automated teardown is scoped to a unique profile, process
group, or tmux socket. It must never signal the live Electron instance launched
from `node_modules` or the production `tmux -L agent-cockpit` server.

## Root causes and evidence

### Cockpit mux became orphaned

`LocalMuxLauncher.launch()` previously started the mux detached with stdin
ignored, then called `unref()`. The daemon had no observable owner, so Electron
exit or SIGKILL left it reparented to PID 1. `will-quit` closed provider clients
but did not stop the daemon. The daemon accepted SIGTERM but did not watch its
parent. Its `Operations.Close()` boundary retained persisted snapshots, which
was useful for state recovery but did not establish process ownership.

An interim fix gave every Electron-launched daemon an inherited owner pipe,
which made the daemon stop on app quit or SIGKILL. That contradicted the mux
contract: users expect live panes to survive closing and reopening Cockpit.
Production `LocalMuxLauncher` now starts an unowned, detached daemon by default;
Electron quit releases clients but does not close the daemon. The owner pipe is
opt-in through `COCKPIT_MUX_EPHEMERAL=1` for isolated test/development runs
whose guardian also owns teardown. The dedicated owner-pipe SIGKILL test uses
that mode; normal topology/relaunch tests exercise production lifetime.

Version 5 of the handoff manifest transfers each PTY session ID plus the
leader start-time identity captured at original launch. Older manifests
without that identity are rejected; the old daemon remains authoritative rather
than adopting a PID it cannot verify. The replacement begins pane-exit
monitoring only after acknowledging ownership; adopted panes observe the
original leader identity instead of treating a missing `exec.Cmd` as an
already-exited shell.

Accepted limitation (user decision, 2026-09-29): the replacement samples
adopted session members while the original leader identity is verifiable. A
helper created after the last successful sample and before the shell exits can
be absent from the captured identity set. Scanning all processes by the numeric
SID after the leader disappears is not a safe fallback: a fully emptied session
can release its SID, which can then be reused by an unrelated session before a
later scan. The current cleanup therefore fails closed and may leave that
narrowly timed helper alive. Closing this gap would require continuous
ownership across handoff (for example, a lifecycle reaper that retains wait
ownership or a stable per-pane supervisor); more frequent polling alone is not
a correctness fix.

### Shell helpers survived direct-PID termination

Pane cleanup previously killed only `exec.Cmd.Process`, which is the shell
leader. Shell integrations and helpers can outlive that process; the observed
zsh/gitstatusd population was consistent with this failure. Interactive job
control can put helpers in process groups other than the shell's group, so
cleanup enumerates kernel process-session membership and signals each member
with TERM, then uses KILL after a bounded grace period. The SID is the private
PTY session created for that pane, not a process group; this includes job-control
helpers and reparented children. An owned pane now observes the shell's exited,
unreaped state (Darwin process-table zombie state; Linux `waitid(WNOWAIT)`),
cleans the private session while the leader still pins its PID/SID, and only
then calls `cmd.Wait()`. An observer failure skips SID-based signaling and
waits/reaps only the owned child. On an adopted pane, the daemon also verifies
the original leader's start identity and records each observed member's start
identity while the leader remains valid. After leader exit, only those
recorded PID/start-time pairs that still belong to the original SID are
signaled; new processes are never selected by a possibly reused SID. After
cleanup, the reader drains PTY EOF and stops on a bounded timeout so a retained
duplicate master cannot hold the lifecycle watcher forever.

Natural pane exit and daemon shutdown serialize attachment finalization under
the operations lock. The attachment's recorder/database handles must not be
closed by the exit watcher while `Operations.Close()` is finalizing its final
keyframe.

### tmux integration tests shared the live socket

`electron/main/providers/local/tmuxControl.test.ts` hard-coded
`-L agent-cockpit`. E2E launch configured an isolated mux home but did not set
`AC_TMUX_SOCKET`, so a scenario using the tmux backend could reach the same
server. Both paths could add sessions to the long-lived production server.
The integration test now gets a unique `ac-test-*` socket and kills its server
after each test. If startup fails after tmux has created the test server, the
fixture closes the manager and kills that exact server before skipping. Packaged
E2E, explicitly isolated-development, and `bin/run-isolated` runs set a unique
socket, enable ephemeral `exit-empty on`, and kill only that socket during
teardown.
The isolated launcher starts a detached guardian before packaging; it watches
the launcher and app identities, owns cleanup of the unique socket/profile,
and removes an incomplete build directory if the launcher dies before app
launch. A successful isolated app build remains available.
Production default behavior is unchanged: detached tmux sessions intentionally
survive application restarts and are not TTL-reaped.

### Playwright hooks were insufficient on hard termination

The E2E spec had `afterEach` cleanup for ordinary completion, but a SIGKILL of
the Playwright runner bypasses all test hooks. The old cleanup also waited only
for SIGTERM of a detached mux and did not verify completion. Direct E2E
invocation rejects non-isolated tmux sockets, including `agent-cockpit`. The
suite now runs under `scripts/run-mux-e2e.mjs`: Playwright, Electron, and their non-detached
children share a dedicated process group; the supervisor terminates/verifies captured, identity-checked groups,
kills the run's exact tmux socket and profile-scoped mux daemon, removes its
unique temp root, and checks for app/mux commands scoped to that root. Only
the separate owner-pipe SIGKILL regression sets `COCKPIT_MUX_EPHEMERAL=1`.
A run-scoped bootstrap remains the
detached-group leader while Playwright runs, so the guardian can identify the
exact group even if the supervisor dies before publishing the runner owner
record. Process manifests are atomically published. SIGINT/SIGTERM
routes through the same bounded teardown. The public-entrypoint SIGKILL
regression runs a packaged app, mux daemon, Playwright, and live isolated tmux
server, then verifies all four are gone. The separate owner-pipe check verifies
mux shutdown without allowing process-group cleanup to mask a broken owner
pipe.

The dev launcher has a separate detached guardian in both modes. A short-lived
launcher starts the guardian in a detached process group before the build
begins. The launcher owns a local socket connection; if it exits or is
SIGKILLed, the guardian detects EOF and stops the `electron-vite` process tree
using captured PID/start-time/command identities. Normal `npm run dev` does
not override Electron `userData` or persistent session resources, and its
guardian never signals the default tmux server. It retains the historical
`agent-cockpit` dev profile, separate from packaged production's `Agent
Cockpit` profile, because the user chose not to migrate existing profile data.
`npm run dev:isolated` instead uses a temporary profile, unique tmux socket,
and mux home; the guardian cleans only those resources. In both modes, the
guardian removes its own temporary control root. Process-group signaling is
permitted only while its exact leader remains present, so an old PGID cannot
target a later unrelated group. The regression fixture SIGKILLs the controller
in both modes and verifies child reaping plus the normal-versus-isolated
resource boundary.

### Repeated spawner and restore behavior

The 2026-09-29 process census found a stale `npm exec electron-builder` →
`electron-builder` → `7za` process tree from the isolated `e2e-rehydrate-2`
packaging run, aged about ten days. That exact stale process tree was stopped
after confirming its command line and did not belong to the live app. The
current process/launch-agent census found no active `mux-merge-validation`
loop, related launchd job, or running agent task. Therefore the source of the
historical repeated `mux-merge-validation-*` launches is not established; no
watcher, cron, or launchd spawner should be claimed without further logs.

The daemon restore path loads persisted panes as recovered snapshots with no
PTY and no command. It does not recreate one shell per stored session, so
restore-on-start does not explain the observed shell bursts. Explicit session
destroy and natural exit already route through logical-session reaping that
removes catalog/history data; shutdown finalizes the terminal snapshot and
marks the logical session dead.

## Session lifetime policy

- Production Cockpit mux daemons and live shells survive Electron quit/relaunch.
  The daemon is detached and is stopped by explicit mux shutdown or host-level
  process management, not by the Electron `will-quit` hook. If the daemon itself
  is stopped, its live panes are terminated and daemon-restart restoration is
  not guaranteed. `COCKPIT_MUX_EPHEMERAL=1` opts isolated tests/development
  into owner-pipe shutdown; their guardian must still reap the exact profile.
- Closing a pane/session explicitly reaps its persisted catalog/history. A
  normal Cockpit quit is not a session close and must not reap that state.
- Production tmux sessions survive UI disconnect and app restart by design.
  Detached status alone is not evidence of abandonment; only an explicit user
  kill removes them. Never set `exit-empty on` or run `kill-server` on the
  production `agent-cockpit` socket from test cleanup.
- Test and isolated-dev tmux servers are intentionally ephemeral, use unique
  socket names, and are removed after the run. The supervisor never queries or
  signals the production socket.

## Verification contract

Run from the repository root:

```sh
npm run test:e2e:mux
npm run test:e2e:mux:supervisor
npm run test:e2e:mux:supervisor:interrupt
npm run test:e2e:mux:verify-cleanup
npm run test:e2e:mux:guardian
npm run test:dev:supervisor
node scripts/test-isolated-run-guardian.mjs
```

These checks verify ordinary supervisor cleanup, interrupt cleanup, owner-pipe
cleanup after forced Playwright termination, public-entrypoint cleanup with a
live packaged app/mux/tmux server, and dev/isolated-launcher cleanup after
SIGKILL. Record before/after counts for `cockpit-mux|gitstatusd` and
`tmux -L agent-cockpit list-sessions`; those global counts must not increase.
The `agent-cockpit` query is read-only. All cleanup commands operate only on
the unique test socket and temporary paths created by that run.
