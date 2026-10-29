/**
 * Evaluating a project's callback environment source at a terminal creation or
 * attach. The feature is best-effort by design: a source that throws (a bug, a
 * not-yet-ready handshake) must never fail the terminal, the attach or the
 * session, so it is logged once per evaluation and treated as "no values".
 */
import type { CallbackEnvironment, CallbackEnvironmentSource } from '@shared/callback/env';
import { logger } from '../logger';

/** `source()`, or `undefined` when there is no source or it threw (logged with `where`). */
export function resolveCallbackEnvironment(
  source: CallbackEnvironmentSource | undefined,
  where: string,
): CallbackEnvironment | undefined {
  if (!source) return undefined;
  try {
    return source();
  } catch (err) {
    logger.error(
      `callback env source threw ${where}: ${err instanceof Error ? err.message : String(err)}`,
      'callback',
    );
    return undefined;
  }
}
