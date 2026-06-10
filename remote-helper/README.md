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
`ProtocolVersion` (currently `1`), the helper returns an error response and the
client re-provisions a compatible binary.

Handshake result: `{ "protocolVersion": 1, "pid": <int> }`.

### Methods

| Method | Params | Result |
|--------|--------|--------|
| `handshake` | `{protocolVersion}` | `{protocolVersion, pid}` |
| `readFile` | `{path}` | `{content, truncated}` (content capped at 2 MiB) |
| `stat` | `{path}` | `{exists, size, isDir, mtime}` |
| `gitStatus` | `{cwd, baseline?}` | `[{path, status}]` |
| `gitDiff` | `{cwd, path, baseline?}` | `{patch}` |
| `listWorktrees` | `{cwd}` | `[{path, branch, head}]` |
| `beadsExec` | `{cwd, args[]}` | `{stdout, exitCode}` |
| `watch.subscribe` | `{cwd, token}` | `{token}` + async `watch` events |
| `watch.unsubscribe` | `{token}` | `{token}` |

### Events

- `watch`: `{ token, paths[] }` — debounced (~150ms) filesystem changes under a
  subscribed root.
- `watchError`: `{ token, error }` — a recoverable watcher error; the process
  does not crash.

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
  "protocolVersion": 1,
  "binaries": [
    {"os": "linux", "arch": "amd64", "filename": "...", "sha256": "..."}
  ]
}
```

Override the version with `make dist VERSION=1.2.3` or
`VERSION=1.2.3 ./build.sh`.
