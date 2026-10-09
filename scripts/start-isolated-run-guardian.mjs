#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [profileRoot, buildRoot, tmuxSocket, ownerPid, ownerStarted] = process.argv.slice(2);
if (!profileRoot || !buildRoot || !tmuxSocket || !ownerPid || !ownerStarted)
  throw new Error('isolated-run guardian launcher requires owner and isolated-resource identities');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guardian = spawn(
  process.execPath,
  [
    join(root, 'scripts/isolated-run-guardian.mjs'),
    profileRoot,
    buildRoot,
    tmuxSocket,
    ownerPid,
    ownerStarted,
  ],
  { detached: true, stdio: 'ignore' },
);
guardian.unref();
