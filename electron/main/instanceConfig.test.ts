import { afterEach, describe, expect, it } from 'vitest';
import { tmuxSocket } from './instanceConfig';

describe('tmuxSocket', () => {
  const savedArgv = process.argv;
  const savedEnv = process.env.AC_TMUX_SOCKET;

  afterEach(() => {
    process.argv = savedArgv;
    if (savedEnv === undefined) delete process.env.AC_TMUX_SOCKET;
    else process.env.AC_TMUX_SOCKET = savedEnv;
  });

  it('defaults to agent-cockpit with no override', () => {
    process.argv = ['node', 'main'];
    delete process.env.AC_TMUX_SOCKET;
    expect(tmuxSocket()).toBe('agent-cockpit');
  });

  it('reads the --tmux-socket CLI flag', () => {
    process.argv = ['node', 'main', '--tmux-socket=test-sock'];
    delete process.env.AC_TMUX_SOCKET;
    expect(tmuxSocket()).toBe('test-sock');
  });

  it('reads AC_TMUX_SOCKET when no flag is given', () => {
    process.argv = ['node', 'main'];
    process.env.AC_TMUX_SOCKET = 'env-sock';
    expect(tmuxSocket()).toBe('env-sock');
  });

  it('prefers the CLI flag over the env var', () => {
    process.argv = ['node', 'main', '--tmux-socket=flag-sock'];
    process.env.AC_TMUX_SOCKET = 'env-sock';
    expect(tmuxSocket()).toBe('flag-sock');
  });

  it('falls back to the default for an unsafe socket name', () => {
    process.argv = ['node', 'main', '--tmux-socket=../bad/name'];
    delete process.env.AC_TMUX_SOCKET;
    expect(tmuxSocket()).toBe('agent-cockpit');
  });
});
