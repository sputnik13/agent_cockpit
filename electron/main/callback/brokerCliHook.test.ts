/**
 * The broker makes sure the local `cockpit` CLI link exists before each local
 * listener binds, so the COCKPIT_CLI that terminals receive once the bind completes
 * resolves; and a failing hook never gates the listener.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallbackBroker } from './broker';

let userData: string;
const brokers: CallbackBroker[] = [];

beforeEach(() => {
  userData = mkdtempSync('/tmp/accb-h-');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((b) => b.stopAll()));
  rmSync(userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function broker(ensureCli?: () => void): CallbackBroker {
  const b = new CallbackBroker({
    statusOf: () => ({ state: 'connected', since: '' }),
    providerOf: () => undefined,
    projectRootOf: () => '/repo',
    userDataDir: () => userData,
    ...(ensureCli ? { ensureCli } : {}),
  });
  brokers.push(b);
  return b;
}

describe('CallbackBroker CLI link hook', () => {
  it('runs before each local listener bind, with the socket not yet bound', async () => {
    let boundAtCall: string | null | undefined;
    const b = broker(() => {
      boundAtCall = b.localSocketPath('p');
    });
    await b.startLocalListener('p');
    expect(boundAtCall).toBeNull(); // the link is made BEFORE terminals can see a socket
    expect(b.localSocketPath('p')).not.toBeNull();
  });

  it('runs again for a restarted listener (a moved or updated app refreshes the link)', async () => {
    const hook = vi.fn();
    const b = broker(hook);
    await b.startLocalListener('p');
    await b.stopListener('p');
    await b.startLocalListener('p');
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('does not gate the listener when the hook throws', async () => {
    const b = broker(() => {
      throw new Error('link failed');
    });
    await b.startLocalListener('p');
    expect(b.localSocketPath('p')).not.toBeNull();
  });

  it('is optional', async () => {
    const b = broker();
    await b.startLocalListener('p');
    expect(b.localSocketPath('p')).not.toBeNull();
  });
});
