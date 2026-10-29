<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=operations -->

# Building & Running

Agent Cockpit is an Electron app compiled by [electron-vite](https://electron-vite.org)
and packaged into standalone distributables by
[electron-builder](https://www.electron.build). Supported dev/build platforms:
macOS and Linux.

## Prerequisites

- **Node.js ≥ 20** (see [`.nvmrc`](../.nvmrc), matching Electron 33).
- **Go ≥ 1.21** — required to build the remote-helper binaries. They are
  cross-compiled from source (CGO disabled) for `linux/amd64`, `linux/arm64`, and
  `darwin/arm64` by [`remote-helper/build.sh`](../remote-helper/build.sh), which
  the `predev`/`prebuild` npm hooks run automatically before every `npm run dev`,
  `build`, or `package`. The binaries are **not checked in**; the script
  short-circuits when the Go source hash is unchanged, so warm builds skip the
  recompile. Go is a **build-time** requirement only — users of a packaged app do
  not need it.

## Run from source (dev mode)

```sh
bin/setup        # first-time: deps + Electron binary + native-module rebuild
bin/run          # runs bin/setup if needed, then `npm run dev`
# or:
npm run dev
```

On a fresh clone run `bin/setup` first (or let `bin/run` call it). Beyond
`npm install` it does two repairs a plain install leaves broken: it ensures the
**Electron binary** is fully extracted (Electron 33's postinstall can leave a
partial `dist/` with no `path.txt` under newer Node — the "Electron failed to
install" error), and it rebuilds the native modules (`better-sqlite3`,
`node-pty`) against **Electron's ABI** (node-gyp builds them
against the system Node, a different `NODE_MODULE_VERSION`). Use the Node version
in [`.nvmrc`](../.nvmrc) (Node 20, matching Electron 33); `bin/setup` repairs the
Electron install under newer Node too, so another Node still works.

This launches the app with hot-reload against the source tree. Nothing is
installed system-wide. DevTools does **not** auto-open — the app starts like a
normal app; open it manually with View → Toggle Developer Tools (⌥⌘I), or launch
with `AC_OPEN_DEVTOOLS=1` to have it open automatically.

`npm run dev` uses the historical Electron profile derived from the root
package name, `agent-cockpit`, and the default persistent terminal resources.
The packaged app uses the separate `Agent Cockpit` product-name profile. This
split is intentional: existing development projects are in the former profile,
and no automatic profile migration is performed. Normal dev does not create or
remove a temporary profile, change the saved terminal backend, or stop
persistent sessions when the dev app exits. To launch a disposable second
instance, use `npm run dev:isolated`; that command gives the run its own
temporary profile, tmux socket, and mux home and cleans only those resources.

## Standalone packages

```sh
bin/package          # package for the current platform -> release/
bin/package --mac    # macOS .dmg + .zip (arm64)
bin/package --linux  # Linux AppImage for the current host architecture
bin/package --dir    # unpacked app only (fast; no installers)
```

Equivalent npm scripts: `npm run package`, `package:mac`, `package:linux`,
`package:dir`. The macOS target is arm64 only. Linux packages must be built on
their matching native hosts because the app's native modules are rebuilt for the
host architecture; run the Linux package command on both arm64 and amd64 Linux
hosts. Other architectures are optional. Each first runs
`npm run mux:build`, which reuses a manifest only
when its source hash matches the current mux source and otherwise builds the next
additive artifact revision. The mux artifact set is macOS/arm64 plus
Linux/arm64 and Linux/amd64. A generated staging directory gives electron-builder
only that manifest and its three verified binaries; the full append-only build
archive is not copied into the app. It then runs `npm run build` and
electron-builder. Artifacts are written to `release/` (gitignored).

### Version

The packaged app's `<version>` comes from the **`vX.Y.Z` release tag**, not the
static `package.json` version. Each package script passes
`-c.extraMetadata.version="$(node scripts/release-version.mjs)"` to
electron-builder; the helper resolves the `vX.Y.Z` tag reachable from `HEAD`, else
the highest `vX.Y.Z` tag in the repo (git tags are shared across worktrees, so the
tag the release flow puts on the public commit is found even when packaging from
`main`), falling back to `package.json` when no release tag exists. Release tags
are created per public/GitHub release by the publish flow (semver, patch
auto-bumped); see the publish-to-github workflow.

Output:

- **macOS:** `release/Agent Cockpit-<version>-arm64.dmg` and `...-arm64-mac.zip`,
  plus the unpacked `release/mac-arm64/Agent Cockpit.app`.
- **Linux:** an AppImage for the host architecture in `release/` (arm64 and x64
  are the supported release architectures).

The two required native modules (`better-sqlite3`, `node-pty`) are rebuilt
against Electron's ABI before packaging; their `.node` binaries are unpacked from
the asar so they load at runtime. `ssh2`'s optional `cpu-features` accelerator is
deliberately not rebuilt because it is incompatible with Electron 42's V8 and ssh2
safely falls back when it is absent.

> Cross-compiling is limited: build macOS artifacts on macOS and Linux artifacts
> on Linux, since native modules are rebuilt for the host.

> Packaging rebuilds the required native modules against Electron's ABI in `node_modules`.
> If a Node-ABI tool (e.g. a standalone script) later complains about a module
> version mismatch, run `npm install` (or `bin/setup`) to restore them. `npm run
dev` and the test suite are unaffected.

On macOS, the package signing hook ad-hoc-signs the staged `cockpit-mux`
Mach-O binaries and the `remote-helper` darwin binary, re-hashes both release
manifests, then seals the enclosing app. It deliberately preserves Electron's
vendor-framework signatures, which keeps both the mux launcher's SHA-256
verification and Electron startup valid. The helper's darwin binary is also the
local `cockpit` CLI (the same Go source, invoked under the program name
`cockpit`): at run time the app links it at `<userData>/callback/bin/cockpit`
from the packaged `remote-helper/dist` (or the built `remote-helper/dist` in a
dev run), so no separate CLI artifact is built or shipped. `build.sh` has no
`darwin/amd64` target, so an Intel Mac has no local CLI. The link follows the app
instance that last bound a listener: a Linux AppImage's resources are a per-run
mount, so the link dangles between runs, and dev runs from several checkouts or
worktrees share one profile and re-point it at the newest (see
`electron/main/callback/cliLink.ts`).

The packaged app also includes the exact `@wterm/ghostty` `ghostty-vt.wasm` binary
as a dedicated resource. Electron serves only that asset through Cockpit's private
`cockpit-wasm:` endpoint; it is never downloaded at runtime.

The mux binary also embeds the `xterm-ghostty` terminfo record generated from the
pinned Ghostty source. At daemon startup it creates the private per-mux cache used
by its PTY children; packaging does not need a system Ghostty install.

## Dev-mode launcher as a clickable .app (macOS)

To launch **dev mode** (Vite + hot reload, runs the live source) like a desktop
app instead of from a terminal:

```sh
bin/make-dev-app            # generates "Agent Cockpit (Dev).app" in release/
bin/make-dev-app ~/Applications   # or generate straight into a target dir
```

The generated `.app` embeds the **absolute path of this checkout**, so it is
per-machine — regenerate it after moving or re-cloning the repo. Copy it into
`/Applications` and launch it from Finder or Spotlight; do not pin the launcher
to the Dock. The launcher is a background-only app, so it does not create a
second Dock icon; only the dev Electron app appears there. When that app quits,
its process-exit signal makes the supervisor stop Vite and the remaining dev
processes. The shim sets up `PATH` (Homebrew/local + nvm) itself, since apps
launched from Finder don't inherit your shell environment.

This is a **dev convenience**, not a standalone build — it needs the repo,
`node_modules`, and Node/npm present. For a self-contained, distributable bundle
use `bin/package` instead. Generated `*.app/` bundles are gitignored.

## macOS: running an unsigned build

The macOS app is **ad-hoc signed** (no Apple Developer certificate), which is
enough to launch on Apple Silicon. If macOS quarantines a copied/downloaded
build ("can't be opened because it is from an unidentified developer"):

```sh
xattr -dr com.apple.quarantine "/Applications/Agent Cockpit.app"
# or right-click the app -> Open the first time.
```

## Enabling real signing + notarization (later)

The packaging config is structured so this is purely additive — targets, native
modules, and scripts stay the same. To distribute to other Macs cleanly:

1. Provide a Developer ID Application certificate (import to the login keychain,
   or set `CSC_LINK` + `CSC_KEY_PASSWORD`).
2. Replace the explicit ad-hoc identity in `electron-builder.yml` with the
   Developer ID identity (or configure `CSC_LINK` + `CSC_KEY_PASSWORD`).
3. In `electron-builder.yml` under `mac`, add `hardenedRuntime: true` and a
   `notarize` block, and set the env `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.

## Install a PATH launcher (alternative)

`bin/install` builds the app and drops a small wrapper in `~/.local/bin` that
runs the app from the repo via the local Electron. This is convenient but is
**not** a self-contained bundle — it depends on the source tree staying in
place. For a relocatable artifact, use `bin/package` instead.

## Running an isolated instance

Automated tests and the screenshot harness launch a second app instance. To keep
it from disturbing a normally-running app, point it at isolated copies of the
resources that overlap between instances:

| Resource                                                      | Override                                          | Effect                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| App user-data (`config.json`, SQLite store, projects, layout) | `--user-data-dir=<path>`                          | Redirects `app.getPath('userData')`; the instance starts empty and never sees the main app's projects. |
| tmux server/socket                                            | `--tmux-socket=<name>` or `AC_TMUX_SOCKET=<name>` | Runs `tmux -L <name>` on a separate server, so sessions never collide with the main app's.             |

With no override set, both default to the normal app (`userData` and the
`agent-cockpit` socket). Example:

```sh
electron out/main/index.js --user-data-dir=/tmp/ac-test --tmux-socket=ac-test
```

The screenshot harness (`scripts/screenshots/`) sets both so it leaves a running
app untouched. The socket override is read in
[electron/main/instanceConfig.ts](../electron/main/instanceConfig.ts).

## Verifying renderer changes end-to-end (Playwright)

`scripts/screenshots/` also holds several `verify-*.mjs` scripts that drive the
REAL packaged renderer with Playwright's `_electron` (isolated per the section
above) and assert on rendered DOM evidence rather than component props —
e.g. `verify-html-preview.mjs`, `verify-explorer-root.mjs`,
`verify-body-search.mjs`, and `verify-content-modes.mjs` (the Content panel's
full content-type x Diff/Rendered/Raw mode matrix). Each is self-documenting in
its own header comment (what it asserts, how to run it). Run one directly:

The harness passes Electron's `--headless` flag. This keeps the verifier
reliable in noninteractive macOS sessions while Playwright continues to drive
the real Electron renderer through its normal debugging connection.

```sh
npm run build && node scripts/screenshots/verify-content-modes.mjs
# or:
npm run verify:content-modes
```

Requires `@playwright/test` >= 1.61.1 (see CLAUDE.md "Native modules on
Electron 42" — earlier versions cannot drive Electron 42's renderer at all).

For standalone privacy-sensitive runs, start the mux daemon with
`--persist-scrollback=false`. It retains session structure but writes no terminal
screen or scrollback bytes to its database. In Cockpit, use **Persist Cockpit
mux scrollback**; the setting is applied before the next mux session is opened
or bridge reconnects, and switching it off erases existing persisted terminal
content while retaining session topology.
