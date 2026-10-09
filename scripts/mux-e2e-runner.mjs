#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [runRoot, executable, ...args] = process.argv.slice(2);
if (!runRoot || !executable) throw new Error('mux e2e runner requires a unique run root');

// This small, run-scoped process stays alive while Playwright runs. Its command
// line contains the unique run-root token, giving the external guardian a safe
// identity during the spawn-before-owner-file window.
const runner = spawn(executable, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      runner.kill(signal);
    } catch {}
  });
}
runner.once('error', (error) => {
  console.error(`failed to start mux e2e runner: ${error.message}`);
  process.exitCode = 1;
});
runner.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
