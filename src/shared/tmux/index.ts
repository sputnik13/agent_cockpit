/**
 * Shared, pure tmux control-mode (`-CC`) subsystem: protocol parsing, byte
 * codecs, window-layout parsing, and command builders. Transport-agnostic and
 * dependency-free so the host managers and the renderer store consume the same
 * model. No I/O, no Electron, no node-pty.
 */
export * from './types';
export * from './codec';
export * from './layout';
export * from './parser';
export * from './commands';
export * from './scrollback';
