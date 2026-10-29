/**
 * The helper RPC protocol version is stated in four places that must agree: the Go
 * helper (`ProtocolVersion`), the TypeScript client (`PROTOCOL_VERSION`), and the
 * two build entry points that stamp the dist manifest (`build.sh`, `Makefile`). A
 * drift would make a freshly built helper fail the handshake forever, or make
 * provisioning stamp a manifest that lies about its protocol. This pins them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './rpcClient';

const HELPER = fileURLToPath(new URL('../../../../remote-helper', import.meta.url));
const read = (name: string): string => readFileSync(join(HELPER, name), 'utf8');

describe('helper protocol version', () => {
  it('is the same number in Go, TypeScript, build.sh and the Makefile', () => {
    const go = /^const ProtocolVersion = (\d+)$/m.exec(read('protocol.go'))?.[1];
    const buildSh = /PROTOCOL_VERSION="\$\{PROTOCOL_VERSION:-(\d+)\}"/.exec(read('build.sh'))?.[1];
    const makefile = /^PROTOCOL_VERSION \?= (\d+)$/m.exec(read('Makefile'))?.[1];
    expect(go).toBeDefined();
    expect(Number(go)).toBe(PROTOCOL_VERSION);
    expect(Number(buildSh)).toBe(PROTOCOL_VERSION);
    expect(Number(makefile)).toBe(PROTOCOL_VERSION);
  });
});
