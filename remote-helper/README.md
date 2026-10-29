# remote-helper

A fully static Go binary that the Agent Cockpit desktop app uploads to a remote
host over SSH and runs to serve **read-only** repository data. It does not link
libgit2 or any C library (`CGO_ENABLED=0`); it shells out to the host's `git`
and `br` (beads) binaries for repository and issue data.

## Protocol

A length-prefixed JSON-RPC protocol runs over stdin/stdout. stdout is reserved
for the RPC channel; all diagnostics go to stderr.

Framing: a 4-byte big-endian `uint32` length header followed by that many bytes
of a single JSON message.

Message shapes:

- Request: `{ "id": <int>, "method": <string>, "params": <object> }`
- Response: `{ "id": <int>, "result": <object|null>, "error": <string|null> }`
- Server-push event (no `id`): `{ "event": <string>, "data": <object> }`

### Handshake

The first exchange must be the `handshake` method. The client sends its
requested `protocolVersion`; if it does not equal the helper's
`ProtocolVersion` (currently `2`), the helper returns an error response and the
client re-provisions a compatible binary.

Handshake params: `{ "protocolVersion": 2, "projectId"?: <string> }`. With a
`projectId` the helper also binds that project's terminal callback socket (see
[Terminal callback socket](#terminal-callback-socket-and-the-cockpit-cli)); the
helper takes no launch arguments, so this is how it learns the project.

Handshake result: `{ "protocolVersion": 2, "pid": <int>, "callbackSock"?: <string>,
"cliPath"?: <string> }`. `callbackSock` is the absolute path of the project's
socket on this host and `cliPath` the absolute path of the `cockpit` CLI link;
both are omitted when callback is unavailable (no `projectId`, no usable
directory, bind failure) with one line on stderr saying why. That never fails
the handshake.

### Methods

| Method | Params | Result |
|--------|--------|--------|
| `handshake` | `{protocolVersion, projectId?}` | `{protocolVersion, pid, callbackSock?, cliPath?}` |
| `readFile` | `{path}` | `{content, truncated}` (content capped at 2 MiB) |
| `stat` | `{path}` | `{exists, size, isDir, mtime}` |
| `gitStatus` | `{cwd, baseline?}` | `[{path, status}]` |
| `gitDiff` | `{cwd, path, baseline?}` | `{patch}` |
| `listWorktrees` | `{cwd}` | `[{path, branch, head}]` |
| `beadsExec` | `{cwd, args[]}` | `{stdout, exitCode}` |
| `watch.subscribe` | `{cwd, token}` | `{token}` + async `watch` events |
| `watch.unsubscribe` | `{token}` | `{token}` |
| `callback.reply` | `{connId, reply}` | `{delivered}` |

`callback.reply` is answered by the reader goroutine itself, never queued behind
another method (see [Concurrency](#concurrency)).

### Events

- `watch`: `{ token, paths[] }` — debounced (~150ms) filesystem changes under a
  subscribed root.
- `watchError`: `{ token, error }` — a recoverable watcher error; the process
  does not crash.
- `callback`: `{ connId, request }` — a request a `cockpit` CLI sent to the
  project's callback socket that passed the helper's edge checks. `request` is
  RE-ENCODED from the fields the helper validated (`v`, `id`, `op`, `pane`, and
  the operation's arguments): unknown fields never reach the app. `connId` is
  unique per request for the life of the helper process (one counter across
  handshakes, so a late `callback.reply` can never reach another request). The
  client answers with `callback.reply`.

## Concurrency

The helper is a reader plus a single worker. The reader decodes frames, answers
`callback.reply` inline and queues every other request on an unbounded FIFO that
the worker drains in arrival order, so a slow `beadsExec`, diff or status cannot
delay a pending callback reply or the next frame, and existing methods keep the
ordering they always had. At EOF on stdin the callback listener is released
first (its socket is unlinked), then the worker finishes the requests already
accepted, then the process exits.

## Terminal callback socket and the cockpit CLI

The same binary is the multi-call `cockpit` CLI. Invoked as `cockpit` (a
symlink) or `remote-helper cockpit …` it dispatches before the PATH bootstrap
and never serves RPC or reads stdin.

```sh
"$COCKPIT_CLI" open <path>   # open <path> in the Content panel of this terminal's project
```

`open` makes the path absolute from the logical working directory (`$PWD`) plus a
lexical clean, sends it with its canonical form (symlink-resolved parent
directory joined with the base name) on `$COCKPIT_CALLBACK_SOCK` together with the
pane identity (`$COCKPIT_CALLBACK_MUX_KEY`, else `$TMUX_PANE`), and prints
nothing on success. Exit codes: `0` dispatched, `2` usage, `3` not connected,
`4` rejected by the app, `1` anything else (including no confirmation within 5 s).

Per project, the helper listens on a unix socket named `<hosthash>-<h>.sock` in
`$XDG_RUNTIME_DIR/agent-cockpit/callback/` (else `~/.agent-cockpit/callback/`),
falling back to `/tmp/ac-cb-<uid>/` when the path would exceed 90 bytes. The
directory is created 0700 and verified (a real directory, owned by the user, no
group/other access), the socket is 0600, and on Linux the peer uid is checked with
`SO_PEERCRED`. A newer listener always takes the path over (temp bind + `rename`);
an owner unlinks on close only if the path is still its own inode. The envelope,
the `open` allowlist and the operation's arguments are validated at the edge
(`bad-request` / `unsupported-op` without a round trip), a burst limit of 10
requests per second applies (`rate-limited`), and what survives is forwarded to
the app as a re-encoded `callback` event and answered with `callback.reply`. The
app re-validates everything and remains the authority. At startup the helper
retargets `~/.agent-cockpit/bin/<os>-<arch>/cockpit` (a fixed name, replaced
atomically; the newest helper launch wins) at its own executable and reports it as
`cliPath`. The limits are 64 KiB frames, one request per connection, a 5 s read
deadline, 16 concurrent connections (a connection past the cap is answered
`rate-limited` and closed) and a 4 s forward timeout.

### Remote file name and old builds

The app uploads the helper to
`~/.agent-cockpit/helper-<version>-<sourceHash12>-<os>-<arch>`, keyed on the first
12 hex characters of the build's source hash (a manifest without `sourceHash`
keeps the unkeyed `helper-<version>-<os>-<arch>`). One path is therefore one build
for good, which is what makes the `cockpit` link safe: it points at an immutable
binary that no other app build (or older app) can overwrite. The upload goes to a
temporary name beside it and is renamed into place (`posix-rename@openssh.com`;
remove-then-rename on an SFTP server without it), so the final name never holds a
partial file and a helper still running from it keeps its inode.

Nothing prunes old builds: every source change leaves one more static binary
(about 4 MB) per os/arch under `~/.agent-cockpit/`, as the cockpit-mux binaries
there also accumulate. Deleting by age is not safe without knowing which file a
running helper or the `cockpit` link still uses, so remove old `helper-*` files by
hand when the space matters (the one the link names is the one to keep:
`readlink ~/.agent-cockpit/bin/<os>-<arch>/cockpit`).

The wire format and the cases the Go code must agree on with the app's
TypeScript reference live in `../src/shared/callback/` (the `fixtures/` there are
replayed by `go test`).

## Invocation

The helper reads framed requests from stdin and writes framed responses and
events to stdout. It shuts down cleanly on stdin EOF. Typical use is to launch
it over SSH with stdio piped to the desktop app:

```sh
ssh host /path/to/helper-0.1.0-linux-amd64
```

## Build

```sh
make build      # native binary -> dist/helper
make test       # go test ./...
make vet        # go vet ./...
make dist       # cross-compile all targets + dist/manifest.json
```

`make dist` (or `./build.sh`) produces static binaries for `linux/amd64`,
`linux/arm64`, and `darwin/arm64` named
`dist/helper-<version>-<os>-<arch>`, plus `dist/manifest.json`:

```json
{
  "version": "0.1.0",
  "protocolVersion": 2,
  "sourceHash": "...",
  "binaries": [
    {"os": "linux", "arch": "amd64", "filename": "...", "sha256": "..."}
  ]
}
```

Override the version with `make dist VERSION=1.2.3` or
`VERSION=1.2.3 ./build.sh`.
