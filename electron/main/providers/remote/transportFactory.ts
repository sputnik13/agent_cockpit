/**
 * createRemoteTransport — the transport-selection seam.
 *
 * For now there is one implementation, so the factory takes no selection key and
 * returns a fresh `Ssh2Transport`. This keeps the FR6 promise: adding an
 * alternate transport (e.g. the separate native-`ssh` proposal) is one factory
 * case plus one new implementation file — no consumer change. `RemoteProvider`
 * constructs its transport through this factory rather than `new Ssh2Transport()`
 * directly, so the seam exists even with a single implementation.
 */
import { Ssh2Transport } from './transport';
import type { RemoteTransport } from './transportTypes';

export function createRemoteTransport(): RemoteTransport {
  return new Ssh2Transport();
}
