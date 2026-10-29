/**
 * The test kit cleans up after itself: killing a sandbox's server must not leave
 * its socket file behind in tmux's socket directory (tmux can, when killed).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTmuxSandbox, isolatedEnv, tmuxInstalled, tmuxSocketFile } from './tmuxTestKit';

describe.skipIf(!tmuxInstalled)('tmux test kit', () => {
  const startServer = (box: ReturnType<typeof createTmuxSandbox>): void => {
    execFileSync(
      'tmux',
      ['-L', box.socket, '-f', box.conf, 'new-session', '-d', '-s', 'kit', 'sleep 30'],
      { env: isolatedEnv(), stdio: 'ignore' },
    );
  };

  it("computes the very file tmux itself uses for the sandbox's socket", () => {
    const box = createTmuxSandbox('kit');
    try {
      startServer(box);
      const reported = box.tmux('display-message', '-p', '#{socket_path}').trim();
      expect(realpathSync(box.socketFile)).toBe(realpathSync(reported));
      expect(box.socketFile).toBe(tmuxSocketFile(box.socket));
    } finally {
      box.dispose();
    }
  });

  it('dispose() removes the socket file and the directory along with the server', () => {
    const box = createTmuxSandbox('kit');
    startServer(box);
    expect(existsSync(box.socketFile)).toBe(true);
    expect(existsSync(box.dir)).toBe(true);
    box.dispose();
    expect(existsSync(box.socketFile)).toBe(false);
    expect(existsSync(box.dir)).toBe(false);
    expect(() =>
      execFileSync('tmux', ['-L', box.socket, 'list-sessions'], {
        env: isolatedEnv(),
        stdio: 'ignore',
      }),
    ).toThrow();
  });

  it('dispose() is safe when the server never started, and leaves no socket file', () => {
    const box = createTmuxSandbox('kit');
    box.dispose();
    expect(existsSync(box.socketFile)).toBe(false);
    expect(existsSync(box.dir)).toBe(false);
    box.dispose(); // and idempotent
  });
});
