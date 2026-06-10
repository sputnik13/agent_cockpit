/**
 * Dev-environment launcher seam. Selected per the global `devEnv.mode` setting,
 * it decides HOW the control-mode tmux server is started on the host so a runaway
 * dev workload can be bounded. The provider depends on the {@link EnvLauncher}
 * interface, not the mode — new modes (devcontainer) are additive launchers
 * behind {@link createEnvLauncher}.
 *
 * NOTE on granularity: the cockpit tmux server runs on the shared `-L
 * agent-cockpit` socket — one server per HOST, with one session per project. So
 * the systemd-scope cap bounds the host's whole cockpit dev workload (a global
 * limit), not a single project. True per-project isolation would need a
 * per-project socket and is a deferred follow-up.
 */
import type { RemoteTransport } from './transportTypes';
import type { DevEnvConfig } from '@shared/settings';
import { logger } from '../../logger';

/** Stable systemd scope unit for the per-host shared cockpit tmux server. */
export const DEV_ENV_SCOPE_UNIT = 'cockpit-devenv';

const TASKS_MAX = 512;

export interface EnvLauncher {
  /** Provision prerequisites before the control session is opened. */
  ensure(): Promise<void>;
  /** Wrap a per-invocation host command (identity for the shipped modes; the
   *  reserved devcontainer mode would inject `docker exec …`). */
  wrapExec(command: string): string;
}

export class EnvLauncherError extends Error {
  readonly phase: 'not-implemented' | 'unsupported-host';
  constructor(message: string, phase: 'not-implemented' | 'unsupported-host') {
    super(message);
    this.name = 'EnvLauncherError';
    this.phase = phase;
  }
}

export interface EnvLauncherContext {
  transport: Pick<RemoteTransport, 'exec'>;
  /** systemd scope unit (per host/socket, stable). */
  scopeUnit: string;
  /** Host label for log messages. */
  hostLabel: string;
  /** The bare `tmux -L <socket> start-server \; set …` command (NO shell env
   *  prefix — systemd-run execs it directly; env is passed via --setenv). */
  serverStartCmd: string;
}

/** Pure builder for the systemd-run scope wrapper around the server-start cmd.
 *  Unit-testable without a host. */
export function systemdScopeWrap(
  opts: { scopeUnit: string; memoryMaxMb: number; tasksMax?: number },
  serverStartCmd: string,
): string {
  const tasks = opts.tasksMax ?? TASKS_MAX;
  return (
    `systemd-run --user --scope --unit=${opts.scopeUnit} ` +
    `-p MemoryMax=${opts.memoryMaxMb}M -p MemorySwapMax=0 -p TasksMax=${tasks} ` +
    // OOMPolicy=continue: when the cap is hit, let the kernel OOM-kill only the
    // offending process(es) (MemoryOOMGroup defaults to no → per-process, not a
    // cgroup-wide group kill) and KEEP the scope + tmux server running. Without
    // it, systemd's default scope OOMPolicy marks the scope `failed` and tears
    // the whole server down — every session/pane on the host dies, not just the
    // runaway. Validated on s13-xeon (oom_kill>0, oom_group_kill=0, scope active).
    `-p OOMPolicy=continue ` +
    // `env -u …` denies the tmux SERVER the systemd user bus so a systemd-enabled
    // tmux cannot move each new pane into its own uncapped `tmux-spawn-*.scope`
    // (which escapes this cap, leaving only the idle server inside it). Panes then
    // inherit the server's cgroup = the cap. BYOBU_DISABLE stays. The `-CC`
    // opener client may keep its bus — only the server gates scope creation.
    `env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR BYOBU_DISABLE=1 ${serverStartCmd}`
  );
}

/** Parse the preflight probe output; return a human reason when the host CANNOT
 *  enforce a scope cap, or null when it can. Pure (unit-testable). */
export function preflightReason(probeStdout: string): string | null {
  const cg = /cg=(\S+)/.exec(probeStdout)?.[1] ?? '';
  if (cg !== 'cgroup2fs') return `cgroup v2 not present (got '${cg || 'none'}')`;
  if (!/Version=\S/.test(probeStdout)) return 'systemd --user bus not reachable';
  if (!/Linger=yes/.test(probeStdout)) return "lingering off — run 'loginctl enable-linger <user>'";
  return null;
}

/** One probe that prints the three preflight facts for {@link preflightReason}. */
const PREFLIGHT_PROBE =
  'printf "cg=%s\\n" "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"; ' +
  'systemctl --user show -p Version 2>/dev/null || echo Version=; ' +
  'loginctl show-user "$(id -u)" -p Linger 2>/dev/null || echo Linger=';

/** Straight tmux — no cap. The shipped default fallback and an explicit choice. */
class TmuxLauncher implements EnvLauncher {
  async ensure(): Promise<void> {
    /* no-op: the opener starts an uncapped server itself. */
  }
  wrapExec(command: string): string {
    return command;
  }
}

/**
 * Start the shared cockpit tmux server inside a memory-capped systemd transient
 * scope. Preflight first; on ANY failure fall back to uncapped tmux with a
 * surfaced WARN (never a hard block, never silent). `wrapExec` is identity: the
 * cap is on the server, so every `-CC` attach and pane inherits it.
 */
class SystemdScopeLauncher implements EnvLauncher {
  constructor(
    private readonly ctx: EnvLauncherContext,
    private readonly memoryMaxMb: number,
  ) {}

  wrapExec(command: string): string {
    return command;
  }

  async ensure(): Promise<void> {
    const { transport, scopeUnit, hostLabel, serverStartCmd } = this.ctx;
    const probe = await transport.exec(PREFLIGHT_PROBE, { timeoutMs: 5_000 }).catch(() => null);
    const reason = probe ? preflightReason(probe.stdout) : 'preflight probe failed';
    if (reason) {
      logger.warn(`dev-env uncapped on ${hostLabel}: ${reason}`, 'dev-env');
      return; // graceful fallback — the opener starts an uncapped server.
    }
    // Idempotent: only create the capped server if the scope isn't already up.
    // (If a server is already running OUTSIDE a scope — e.g. started uncapped by
    // a prior connect — this no-ops the start and leaves it uncapped until the
    // server is restarted; logged below when the scope didn't come up.)
    const cmd =
      `systemctl --user is-active ${scopeUnit}.scope >/dev/null 2>&1 || ` +
      systemdScopeWrap({ scopeUnit, memoryMaxMb: this.memoryMaxMb }, serverStartCmd);
    const res = await transport.exec(cmd, { timeoutMs: 10_000 }).catch((e: unknown) => {
      logger.warn(`dev-env uncapped on ${hostLabel}: scope start failed (${String(e)})`, 'dev-env');
      return null;
    });
    if (res && res.code !== 0 && res.code !== null) {
      logger.warn(
        `dev-env uncapped on ${hostLabel}: scope start exited ${res.code}: ` +
          `${res.stderr.trim() || res.stdout.trim()}`,
        'dev-env',
      );
    } else if (res) {
      logger.info(`dev-env capped on ${hostLabel}: ${scopeUnit}.scope MemoryMax=${this.memoryMaxMb}M`, 'dev-env');
    }
  }
}

/** Reserved: a future Docker/devcontainer mode. Not runtime-supported yet. */
class DevcontainerLauncher implements EnvLauncher {
  private fail(): never {
    throw new EnvLauncherError('devcontainer mode is not yet supported', 'not-implemented');
  }
  async ensure(): Promise<void> {
    this.fail();
  }
  wrapExec(): string {
    return this.fail();
  }
}

/** Select the launcher for the (global) dev-env config. */
export function createEnvLauncher(devEnv: DevEnvConfig, ctx: EnvLauncherContext): EnvLauncher {
  switch (devEnv.mode) {
    case 'tmux':
      return new TmuxLauncher();
    case 'systemd-scope':
      return new SystemdScopeLauncher(ctx, devEnv.memoryMaxMb);
    default:
      // 'devcontainer' (reserved) or any unexpected value.
      return new DevcontainerLauncher();
  }
}
