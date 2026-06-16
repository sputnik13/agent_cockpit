/**
 * Beads write runner — the single seam for MUTATING the beads store via the
 * `br` CLI. All writes (close/reopen/comment/create) and the comment read go
 * through `br` (audit trail, policy gates, WAL handling, JSONL sync); the
 * read-only graph path stays on the direct SQLite reader. `br` is always invoked
 * with an argv array (never a shell string) so issue ids / titles / messages
 * cannot inject (FR6.4).
 *
 * The argv builders and JSON parsers are shared by BOTH transports: the local
 * provider runs them through {@link runBr} (`spawnSync`), and the remote provider
 * passes the same argv to the helper's `beadsExec` RPC (which execs `br` with the
 * same argv on the remote host). One authoring site keeps the two paths identical.
 */
import { spawnSync } from 'node:child_process';
import type { BeadsComment, BeadsCreateInput } from '@shared/ipc/channels';
import { resolveBin } from '../pathBootstrap';

/**
 * `br` argv builders (without the leading `br` or the trailing `--json`). Shared
 * by the local `spawnSync` path and the remote `beadsExec` RPC so both run
 * identical, injection-safe commands.
 */
export const beadsArgs = {
  close: (id: string, reason?: string): string[] =>
    reason ? ['close', id, '--reason', reason] : ['close', id],
  reopen: (id: string): string[] => ['reopen', id],
  comment: (id: string, message: string): string[] => ['comments', 'add', id, '--message', message],
  create: (input: BeadsCreateInput): string[] => {
    const args = ['create', input.title];
    if (input.parent) args.push('--parent', input.parent);
    if (input.priority != null) args.push('-p', String(input.priority));
    if (input.description) args.push('-d', input.description);
    return args;
  },
  listComments: (id: string): string[] => ['comments', 'list', id],
};

/** Map `br comments list --json` output ({id, issue_id, author, text,
 *  created_at}) into {@link BeadsComment}s. Tolerant of an empty body. */
export function parseComments(stdout: string): BeadsComment[] {
  const raw = stdout.trim();
  if (!raw) return [];
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) return [];
  return data.map((c): BeadsComment => {
    const o = c as Record<string, unknown>;
    return {
      id: typeof o.id === 'number' ? o.id : Number(o.id) || 0,
      issueId: String(o.issue_id ?? ''),
      author: String(o.author ?? ''),
      text: String(o.text ?? ''),
      createdAt: String(o.created_at ?? ''),
    };
  });
}

/** Best-effort extraction of the created issue id from `br create --json`. */
export function parseCreatedId(stdout: string): string | null {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

/** Pull a human-readable message out of `br`'s failure output (a JSON error
 *  envelope on stdout, else stderr, else any stdout). */
export function beadsErrorMessage(stdout: string | null, stderr: string | null): string | null {
  const out = (stdout ?? '').trim();
  if (out) {
    try {
      const env = JSON.parse(out) as Record<string, unknown>;
      const m = env.error ?? env.message;
      if (typeof m === 'string' && m) return m;
    } catch {
      /* not a JSON envelope; fall through to stderr/stdout */
    }
  }
  const err = (stderr ?? '').trim();
  return err || out || null;
}

/**
 * Run `br <args> --json` in `cwd` (LOCAL provider path). Returns stdout on
 * success; throws an Error carrying `br`'s message on a non-zero exit or a spawn
 * failure (e.g. `br` not on PATH). argv only — no shell.
 */
export function runBr(cwd: string, args: string[]): string {
  const res = spawnSync('br', [...args, '--json'], { cwd, encoding: 'utf8' });
  if (res.error) {
    // ENOENT here almost always means br is installed but not on the PATH the
    // app inherited (e.g. a Dock launch with launchd's minimal PATH). Name the
    // effective PATH so it reads as a setup issue, not an app bug.
    const enoent = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
    const hint = enoent && !resolveBin('br') ? ` (br not found on PATH: ${process.env.PATH ?? ''})` : '';
    throw new Error(`br ${args[0] ?? ''}: ${res.error.message}${hint}`);
  }
  if (res.status !== 0) {
    throw new Error(
      beadsErrorMessage(res.stdout, res.stderr) ?? `br ${args.join(' ')} exited ${String(res.status)}`,
    );
  }
  return res.stdout ?? '';
}
