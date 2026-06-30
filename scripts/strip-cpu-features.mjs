// Remove the optional native module `cpu-features` after install.
//
// Why: `cpu-features` (a transitive *optional* dependency of ssh2 — it detects
// CPU crypto features like AES-NI to pick faster paths) calls `v8::External::New`
// with the pre-V8-13.6 two-argument signature, both in its own `binding.cc` and
// via `nan` (2.28 still ships the old signature). On Electron 42 (V8 13.6) it
// fails to compile, which aborts `electron-builder`'s native rebuild even though
// every REQUIRED native (better-sqlite3, node-pty) builds fine.
//
// ssh2 guards `require('cpu-features')` in a try/catch and falls back to pure-JS /
// OpenSSL crypto when it is absent, so removing it is functionally safe — only a
// minor crypto micro-optimization is lost. Re-evaluate (and delete this script)
// when cpu-features/nan ship V8-13.6 support — tracked alongside the Electron
// upgrade bead.
//
// Idempotent: a no-op when the module isn't present.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'node_modules', 'cpu-features');
try {
  rmSync(target, { recursive: true, force: true });
} catch {
  /* best-effort; absence is the desired state */
}
