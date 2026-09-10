<!-- AI NOTE: doc_standard=engineering-docs-standards; version=2; doc_kind=reference -->

# Ghostty-WASM custom WebGL renderer viability

## Purpose

This record answers a narrow but consequential question: can Agent Cockpit
replace its current DOM-based wterm renderer with a **custom WebGL renderer**
over a current `libghostty-vt` build compiled to browser WebAssembly, without
lowering the existing terminal contract?

The answer is **no for the current official browser-WASM artifact**. This is a
production-readiness decision, not a claim that WebGL or native
`libghostty-vt` is incapable in principle.

## Bottom line

Native current `libghostty-vt` contains the Kitty graphics inspection API a
custom renderer needs: image pixels, placement iteration, geometry, layers,
and generation stamps. The documented browser target is instead
`wasm32-freestanding`, and Ghostty deliberately compiles Kitty graphics out
for that target. The resulting module has zero `ghostty_kitty_graphics_*`
exports.

That alone prevents the required graphics vertical slice—capability reply,
direct transfer, visible placement, deletion, resize, and scrolling—from being
implemented by a WebGL renderer. A renderer cannot recover image data that its
WASM terminal core did not retain or expose.

The result is therefore:

> Retain wterm. Do not begin a production custom-WebGL renderer package until
> Ghostty provides a supported browser-WASM Kitty graphics build and binding
> surface, then re-run the complete Cockpit evaluation.

## Scope and terminology

Three separate things were evaluated and must not be conflated:

| Subject                            | What it establishes                                                                                              | What it does not establish                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ghostty-web` 0.4.0 Canvas wrapper | A maintained wrapper can load Ghostty WASM, paint a canvas, and encode basic terminal input in Cockpit Electron. | Whether current upstream raw `libghostty-vt` can power a complete custom renderer. |
| Experimental WebGL2 surface        | Ghostty-derived grid state can be drawn through WebGL2, accept live PTY input, and expose a context-loss state.  | Fidelity, semantic DOM, or graphics capability for a current raw ABI.              |
| Current upstream `libghostty-vt`   | Native C API capability and the official browser-WASM artifact's actual API boundary.                            | A production-ready browser binding or renderer.                                    |

The wrapper experiments are a **NO-GO for those wrappers**, not a permanent
NO-GO for all possible WebGL implementations. The current browser-WASM build
is a separate **NO-GO for a full-contract custom renderer today**.

## Reproducible source evidence

The source examined was `ghostty-org/ghostty` main revision
`3c1ef5b32fc5ea6b93d28493fabf193f595139cf`.

The documented build completed successfully:

```text
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
```

The resulting 807,399-byte module identified itself as `wasm32-freestanding`
and exposed the following API families:

| API family                        | Export count | Significance                                                                        |
| --------------------------------- | -----------: | ----------------------------------------------------------------------------------- |
| Render state                      |           22 | Enough incremental terminal-grid state for a custom renderer.                       |
| Grid and scrollback introspection |           13 | Useful for a semantic DOM, selection, hyperlink, and inspection layer.              |
| Input: key, mouse, focus, paste   |           42 | Core encoders exist, but Cockpit must bind browser events and own shortcut routing. |
| Selection                         |           21 | Native primitives exist; they do not produce browser semantics by themselves.       |
| Search                            |            8 | Native primitives exist; they do not create a find UI or DOM highlights.            |
| Kitty graphics                    |        **0** | Required image state is absent.                                                     |

Current native `libghostty-vt` focused Kitty-graphics tests passed 73/73. This
proves the native core and its C API support the graphics model; it does not
make that model available to the browser artifact.

## Why Kitty graphics is compiled out

Ghostty's build options state that Kitty graphics requires timestamps from the
operating system and therefore force the feature off on freestanding targets.
The implementation currently includes all Kitty image transport modes together:
direct payloads, files, temporary files, and shared memory.

In a throwaway source checkout, forcing Kitty graphics on for the documented
browser target fails compilation in the image-loading implementation. The
first errors require `PATH_MAX`/file reads and POSIX APIs that do not exist for
`wasm32-freestanding`. An attempted `wasm32-wasi` build also fails in the
current upstream build configuration because the required C runtime is not
linked. Neither route produces a shippable Electron-renderer module.

This is broader than a missing JavaScript wrapper function. A viable browser
target needs an intentional platform split rather than a build flag:

1. a browser-provided monotonic clock for graphics timing;
2. browser-safe PNG decoding and bounded direct-transfer memory management;
3. no file, temporary-file, or shared-memory transports in the renderer;
4. exported graphics placement and pixel APIs; and
5. a maintained TypeScript binding that safely follows Ghostty's evolving ABI.

Ghostty describes `libghostty-vt` as a work-in-progress, unstable C API. Its
current native graphics API and browser utility API are documented in the
[upstream VT header](https://github.com/ghostty-org/ghostty/blob/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/include/ghostty/vt.h),
[Kitty graphics header](https://github.com/ghostty-org/ghostty/blob/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/include/ghostty/vt/kitty_graphics.h),
and [WASM header](https://github.com/ghostty-org/ghostty/blob/3c1ef5b32fc5ea6b93d28493fabf193f595139cf/include/ghostty/vt/wasm.h).

## Cockpit requirement audit

The current wterm renderer is the fidelity baseline. A replacement must retain
the reasons the project adopted DOM rendering rather than win solely on
throughput.

| Requirement                                                                           | Evidence for a direct current-ABI WebGL renderer                                                                                                          | Status                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Ghostty terminal state in WASM                                                        | Official browser build succeeds and exposes render state, grid, scrollback, selection, search, and input APIs.                                            | Available foundation                        |
| WebGL glyph painting                                                                  | Lab WebGL2 prototype painted Ghostty-derived state and processed a live PTY stream. It did not bind the current raw ABI.                                  | Technically plausible; unproven for raw ABI |
| Kitty query/reply, direct transfer, placement, deletion, resize, scroll               | Native API has renderer-side image state; browser build exports none and force-enabling it does not compile.                                              | **Fails hard gate**                         |
| Complex scripts, fallback fonts, ligatures, Powerline/Nerd glyphs, wide/combining/ZWJ | Core can expose graphemes and widths. Browser font fallback, shaping, glyph-atlas behavior, geometry, and visual parity remain renderer responsibilities. | Unproven                                    |
| Selection, copy, find, accessibility                                                  | Native selection/search primitives are useful, but a WebGL surface needs an accurate bounded semantic DOM through scrollback and reflow.                  | Unproven                                    |
| Keyboard, paste, Kitty keyboard, focus, mouse handoff, shortcuts, menus               | Input encoders exist. The lab directly proved printable and ArrowUp paths through the wrapper only.                                                       | Unproven for direct ABI                     |
| Native IME/composition                                                                | Trusted OS composition cannot be synthesized by Chromium automation and has not received a manual Electron check.                                         | Unproven                                    |
| Reparenting, resize, fractional/high DPR, context loss                                | Lab surface visibly reports context loss. Reparenting, geometry, recovery, and high-DPR parity were not evaluated against a raw current ABI.              | Unproven                                    |
| Secure Electron packaging                                                             | Browser WASM must be served through a narrow packaged-asset protocol; `file:` access in the renderer remains disallowed.                                  | Unproven                                    |
| Performance and memory                                                                | Current upstream enables WASM SIMD. No damaged-frame, CPU/GPU, interaction-latency, or long-lived-memory comparison against wterm exists.                 | Unproven                                    |
| Maintenance and compatibility                                                         | No maintained browser graphics artifact or stable TypeScript binding exists; the C ABI is explicitly unstable.                                            | **Fails adoption bar**                      |

The two failing rows make a full-requirements GO impossible. The unproven rows
remain real acceptance work; they cannot be marked passing from API presence or
a smoke-test rendering demo.

## Electron evidence retained from the lab

The isolated Cockpit Electron suite uses a fresh user-data directory, unique
tmux socket, serial Playwright execution, and live raw PTY probes. Its seven
tests pass:

- current wterm control-mode baseline delivers `abcde` as bytes
  `61 62 63 64 65` to the real PTY;
- Canvas Ghostty-WASM experiment renders and sends printable input plus
  `ArrowUp` as `ESC [ A`;
- WebGL2 experiment draws Ghostty-derived terminal state, delivers live PTY
  input, and surfaces a recoverable context-loss state; and
- both wrapper experiments issue a Kitty capability query and receive no
  response, correctly avoiding a false graphics claim.

This evidence demonstrates the test seam and the WebGL direction. It is not a
substitute for a current raw-ABI browser graphics implementation.

## Production path if upstream support arrives

Only re-open a production candidate after a maintained, version-pinned browser
WASM release supplies the graphics feature. The next package must then:

1. build a thin TypeScript adapter from the ABI manifest rather than maintain
   opaque C-structure guesses by hand;
2. deliver the exact WASM asset over a fixed Electron protocol with integrity
   and version checks, without filesystem privilege in the renderer;
3. implement the WebGL glyph and image layers together with a bounded semantic
   DOM, exact selection/copy, find, clipboard, and accessible output model;
4. run the shared direct-Electron input, trusted-IME manual, lifecycle,
   reparenting, resize, DPR, and Kitty graphics vertical-slice tests; and
5. compare screenshot/geometry fidelity, damaged-frame time, interaction
   latency, CPU/GPU behavior where observable, and long-run memory against
   wterm using representative shell, monitor, and editor workloads.

The decision can change only when those checks produce evidence. Higher raw
WebGL throughput alone is not enough.

## Non-goals of this record

This research does not modify the production terminal renderer, settings,
backend, defaults, or dependencies. It does not adopt a Ghostty fork, add an
Electron privilege, or create a migration plan. It records why those actions
would be premature now and what evidence would authorize reconsideration.
