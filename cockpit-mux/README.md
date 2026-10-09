# cockpit-mux

The M1A standalone mux component. Its build and tests do not require Node or
Cockpit.

## Native libghostty-vt setup

`make test` runs both the pure-Go suite and the libghostty-vt shadow suite. On
the first run it fetches and builds the pinned Ghostty revision into
`cockpit-mux/.build/libghostty-vt/native`; later runs reuse that exact prefix.

```sh
make test
make build-shadow
```

`make build` writes the runnable native daemon to `bin/cockpit-mux`. It uses
`COCKPIT_MUX_HOME` for an isolated runtime home, or `--home <path>` for an
explicit equivalent. `--scrollback-lines` controls the finite live-history
target per pane (10,000 by default; Ghostty prunes at page granularity). Pass
`--persist-scrollback=false` to retain session topology without writing screen,
scrollback, or the optional long-history archive to private storage. With
persistence enabled, finalized rows spill as compressed 1 MiB batches (or on
idle/clean close) into a private archive that is reaped when its pane closes.
Cockpit exposes both settings and applies them before pane creation or bridge
reconnect; changing the line target also updates existing native shadows.

The provisioner requires Git, Go 1.27 or newer, and Zig 0.16 or newer. It pins
Ghostty to `f2d5758f6305867dc36b36293c6165d8152b853e`, rather than using a
system installation or the temporary feasibility-spike build.

Use `make provision-libghostty LIBGHOSTTY_TARGET=<zig-target>` to create a
separate target-specific prefix. Provisioning only builds the native library;
cross-compiling the Go binary remains a separate build step because its C
compiler and linker must match the selected target.

The provisioner never cleans, deletes, or replaces an existing source checkout
or install prefix. If an earlier build left an incomplete path, it stops and
names that path for manual inspection rather than removing it.
