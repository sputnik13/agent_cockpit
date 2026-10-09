/**
 * Single source of truth for the control-mode scrollback target depth.
 *
 * The same value feeds three layers that must not drift apart (changing one
 * without the others reintroduces lost or truncated history):
 *   - the tmux server `history-limit` set at session open (how much history the
 *     server retains per pane),
 *   - the `capture-pane -S -N` seed depth (how much history is replayed on
 *     attach), and
 *   - the renderer xterm `scrollback` buffer (how much the user can scroll
 *     back through).
 *
 * The embedded daemon policy is the cross-language source of truth; this module
 * exposes it to the main process and renderer alongside `commands.ts`.
 */
import muxScrollbackPolicy from '../../../cockpit-mux/daemon/scrollback-policy.json';

export const TERMINAL_SCROLLBACK = muxScrollbackPolicy.max_lines;
