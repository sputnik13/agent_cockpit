# Building & Running

Agent Cockpit is an Electron app compiled by [electron-vite](https://electron-vite.org)
and packaged into standalone distributables by
[electron-builder](https://www.electron.build). Supported dev/build platforms:
macOS and Linux.

## Run from source (dev mode)

```sh
bin/run          # installs deps if needed, then `npm run dev`
# or:
npm run dev
```

This launches the app with hot-reload against the source tree. Nothing is
installed system-wide. DevTools does **not** auto-open — the app starts like a
normal app; open it manually with View → Toggle Developer Tools (⌥⌘I), or launch
with `AC_OPEN_DEVTOOLS=1` to have it open automatically.

## Standalone packages

```sh
bin/package          # package for the current platform -> release/
bin/package --mac    # macOS .dmg + .zip (arm64)
bin/package --linux  # Linux AppImage
bin/package --dir    # unpacked app only (fast; no installers)
```

Equivalent npm scripts: `npm run package`, `package:mac`, `package:linux`,
`package:dir`. Each runs `npm run build` first, then electron-builder. Artifacts
are written to `release/` (gitignored).

Output:

- **macOS:** `release/Agent Cockpit-<version>-arm64.dmg` and `...-arm64-mac.zip`,
  plus the unpacked `release/mac-arm64/Agent Cockpit.app`.
- **Linux:** `release/Agent Cockpit-<version>.AppImage`.

The three native modules (`better-sqlite3`, `node-pty`, `ssh2`) are rebuilt
against Electron's ABI and bundled automatically; their `.node` binaries are
unpacked from the asar so they load at runtime.

> Cross-compiling is limited: build macOS artifacts on macOS and Linux artifacts
> on Linux, since native modules are rebuilt for the host.

> Packaging rebuilds the native modules against Electron's ABI in `node_modules`.
> If a Node-ABI tool (e.g. a standalone script) later complains about a module
> version mismatch, run `npm install` (or `bin/setup`) to restore them. `npm run
> dev` and the test suite are unaffected.

## Dev-mode launcher as a clickable .app (macOS)

To launch **dev mode** (Vite + hot reload, runs the live source) like a desktop
app instead of from a terminal:

```sh
bin/make-dev-app            # generates "Agent Cockpit (Dev).app" in release/
bin/make-dev-app ~/Applications   # or generate straight into a target dir
```

The generated `.app` embeds the **absolute path of this checkout**, so it is
per-machine — regenerate it after moving or re-cloning the repo. It's copyable:
drop it in `/Applications` or drag it to the Dock and launch dev mode with a
click. The shim sets up `PATH` (Homebrew/local + nvm) itself, since apps launched
from Finder don't inherit your shell environment.

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
2. Stop forcing ad-hoc signing: run electron-builder **without**
   `CSC_IDENTITY_AUTO_DISCOVERY=false` (the `package`/`package:mac` scripts set
   it; drop it once you have a cert).
3. In `electron-builder.yml` under `mac`, add `hardenedRuntime: true` and a
   `notarize` block, and set the env `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.

## Install a PATH launcher (alternative)

`bin/install` builds the app and drops a small wrapper in `~/.local/bin` that
runs the app from the repo via the local Electron. This is convenient but is
**not** a self-contained bundle — it depends on the source tree staying in
place. For a relocatable artifact, use `bin/package` instead.
