/**
 * Scenario 15 (value handling): a value injected into a terminal environment is
 * never restricted by charset, only rejected when it contains NUL or a line
 * break; and, quoted with the app's tmux quoting, it reaches tmux exactly.
 * The tmux half runs a real tmux on a private `-L` socket (skipped when tmux is
 * not installed) and never touches the persistent cockpit server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInjectableEnvValue } from '@shared/callback/protocol';
import { shellQuote } from '@shared/tmux/commands';
import { deriveSocketLocation } from './socketPath';

const tmuxInstalled = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/** Values with every character class a path or key can legally carry. */
const AWKWARD_VALUES = [
  'plain',
  '/Users/me/Library/Application Support/Agent Cockpit/callback/abc.sock',
  '  leading and trailing  ',
  'dollar $HOME and $(subshell) and ${braces}',
  'semi;colon; and && and || and |',
  'tilde ~ and ~/home and ~user',
  'hash # and #{pane_id} and #(cmd)',
  "single ' quote and 'quoted' and it's",
  'double " quote and `backtick`',
  'back\\slash and \\n and \\\\',
  'braces { } and [brackets] and %if and %endif',
  '日本語 and émoji 🙂',
  'glob * ? and !bang',
];

describe('injected environment values (scenario 15)', () => {
  it('are accepted whatever characters they carry, except NUL and line breaks', () => {
    for (const value of AWKWARD_VALUES) expect(isInjectableEnvValue(value)).toBe(true);
    for (const value of ['a\0b', 'a\nb', 'a\r\nb']) expect(isInjectableEnvValue(value)).toBe(false);
  });

  it('may be a socket path with spaces and shell metacharacters in the userData directory', () => {
    const userDataDir = "/Users/me/My Apps/$HOME;~#'x'";
    const { socketPath } = deriveSocketLocation({ userDataDir, projectId: 'p1' });
    expect(isInjectableEnvValue(socketPath)).toBe(true);
    expect(shellQuote(socketPath)).toBe(`'${socketPath.replace(/'/g, `'\\''`)}'`);
  });
});

describe('a hostile userData directory', () => {
  it('yields an injectable socket path by way of the /tmp fallback instead of disabling callback', () => {
    const { socketPath, fallback } = deriveSocketLocation({
      userDataDir: '/tmp/Apps\nSupport',
      projectId: 'p1',
      tmpRoot: '/tmp/accb-iv-root', // pure derivation: nothing is created
    });
    expect(fallback).toBe(true);
    expect(isInjectableEnvValue(socketPath)).toBe(true);
  });
});

describe.skipIf(!tmuxInstalled)('tmux quoting round trip (scenario 15)', () => {
  const socket = `ac-test-quote-${process.pid}-${randomBytes(3).toString('hex')}`;
  let dir: string;
  const env = { ...process.env };
  delete env['TMUX'];
  delete env['TMUX_PANE'];

  const tmux = (...args: string[]): string =>
    execFileSync('tmux', ['-L', socket, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  beforeAll(() => {
    dir = mkdtempSync('/tmp/accb-q-');
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'q', 'sleep 60');
  });

  afterAll(() => {
    try {
      tmux('kill-server');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Set `value` through a tmux command LINE (the same parser a control-mode line uses) and read it back. */
  function roundTrip(value: string): string {
    const conf = join(dir, `${randomBytes(4).toString('hex')}.conf`);
    writeFileSync(conf, `set-environment -g COCKPIT_QUOTE_PROBE ${shellQuote(value)}\n`);
    tmux('source-file', conf);
    const shown = tmux('show-environment', '-g', 'COCKPIT_QUOTE_PROBE');
    return shown.replace(/^COCKPIT_QUOTE_PROBE=/, '').replace(/\n$/, '');
  }

  it.each(AWKWARD_VALUES.map((value) => [value]))('delivers %j exactly', (value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it('delivers a socket path derived from a hostile userData directory exactly', () => {
    const { socketPath } = deriveSocketLocation({
      userDataDir: "/tmp/My Apps/$HOME;~#'x'",
      projectId: 'p1',
    });
    expect(roundTrip(socketPath)).toBe(socketPath);
  });
});
