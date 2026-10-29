/**
 * An old tmux that rejects the indexed `update-environment[N]` form, EMULATED:
 * a `tmux` wrapper at the front of PATH reports `tmux 2.6`, rejects any command
 * line that sets `update-environment[N]` the way such a tmux would (everything
 * BEFORE it in a `;` chain has already run; the failing command and the rest do
 * not) and otherwise hands over to the real tmux on a private socket. This is the
 * defined-diagnostic escalation trigger exercised through the real opener, not a
 * run against a genuinely old tmux (none is installed here).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';
import { subscribe, type LogEntry } from '../../logger';
import { LocalTmuxControlManager } from './tmuxControl';
import { __resetTmuxServerDiagnosticsForTests } from './tmuxServer';
import { createTmuxSandbox, tmuxInstalled, type TmuxSandbox } from './tmuxTestKit';

const ENV = buildCallbackEnvironment({
  sock: '/tmp/a/aaaaaaaaaaaa.sock',
  cli: '/tmp/a/bin/cockpit',
})!;

const WRAPPER = (realTmux: string): string => `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const real = ${JSON.stringify(realTmux)};
const args = process.argv.slice(2);
if (args[0] === '-V') { console.log('tmux 2.6'); process.exit(0); }
const at = args.findIndex((a) => a.startsWith('update-environment['));
const run = (list) => spawnSync(real, list, { stdio: 'inherit' }).status ?? 1;
if (at === -1) process.exit(run(args));
// The command that sets the indexed element fails, and so does the rest of its ';' chain.
const sep = args.lastIndexOf(';', at);
if (sep > 0) run(args.slice(0, sep)); // everything before it already ran
console.error('invalid option: ' + args[at]);
process.exit(1);
`;

let box: TmuxSandbox;
let wrapperDir: string;
let savedPath: string | undefined;
let logs: LogEntry[];
let unsubscribe: () => void;
const managers: LocalTmuxControlManager[] = [];

beforeEach(() => {
  __resetTmuxServerDiagnosticsForTests();
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
  box = createTmuxSandbox('oldtmux');
  const real = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
  wrapperDir = mkdtempSync(join(tmpdir(), 'accb-oldtmux-'));
  writeFileSync(join(wrapperDir, 'tmux'), WRAPPER(real));
  chmodSync(join(wrapperDir, 'tmux'), 0o755);
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${wrapperDir}${delimiter}${savedPath ?? ''}`;
});

afterEach(() => {
  for (const mgr of managers.splice(0)) mgr.close();
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  box.dispose();
  rmSync(wrapperDir, { recursive: true, force: true });
  unsubscribe();
  vi.restoreAllMocks();
});

async function attach(token: string): Promise<LocalTmuxControlManager> {
  const mgr = new LocalTmuxControlManager(token, box.dir, box.socket, box.conf, () => ENV);
  managers.push(mgr);
  mgr.open({ cols: 80, rows: 24 });
  await mgr.command("display-message -p '#{session_name}'");
  return mgr;
}

describe.skipIf(!tmuxInstalled)(
  'an old tmux that rejects the indexed update-environment form (emulated)',
  () => {
    it('reports ONE defined diagnostic naming the tmux version, instead of a silently absent feature', async () => {
      await attach('proj-a');
      const warnings = logs.filter((l) => l.level === 'warn' && l.context === 'callback');
      expect(warnings).toHaveLength(1);
      const message = warnings[0]!.message;
      expect(message).toContain('callback env unavailable');
      expect(message).toContain(`socket=${box.socket}`);
      expect(message).toContain('reason=update-environment-set-failed');
      expect(message).toContain('tmux="tmux 2.6"');
      expect(message).toContain('option="update-environment[100]"');
      expect(message).toContain('invalid option: update-environment[100]');
      expect(message).toContain('will not receive COCKPIT_CALLBACK_*');
    });

    it('loses only the feature: the rest of the chain ran, the session opens, panes just have no variables', async () => {
      const mgr = await attach('proj-a');
      const session = mgr.sessionName();
      const [first] = box
        .tmux('list-panes', '-s', '-t', `=${session}`, '-F', '#{pane_id}')
        .split('\n')
        .filter(Boolean);
      const env = await box.paneEnv(first!);
      expect([...env.keys()].filter((n) => n.startsWith('COCKPIT_'))).toEqual([]);
      // Everything before the failing command in the chain was applied.
      expect(box.tmux('show-options', '-gv', 'automatic-rename').trim()).toBe('off');
      expect(box.tmux('show-options', '-gv', 'exit-empty').trim()).toBe('off');
      expect(box.tmux('show-options', '-gv', 'mouse').trim()).toBe('on');
      // Nothing leaked either way.
      expect(box.globalEnv().filter((l) => /COCKPIT_/.test(l))).toEqual([]);
      expect([...box.updateEnvironment().keys()].filter((i) => i >= 100)).toEqual([]);
    });

    it('does not repeat the diagnostic for every later open on the same server', async () => {
      await attach('proj-a');
      managers.splice(0).forEach((m) => m.close());
      await attach('proj-b');
      await attach('proj-c');
      expect(logs.filter((l) => l.level === 'warn' && l.context === 'callback')).toHaveLength(1);
    });
  },
);
