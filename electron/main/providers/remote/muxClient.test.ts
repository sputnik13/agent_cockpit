import { decode, encode } from '@msgpack/msgpack';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MuxClient } from './muxClient';

function channel() {
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
}

function frame(value: unknown): Buffer {
  const payload = encode(value);
  const result = Buffer.alloc(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(result, 4);
  return result;
}

function readFrame(buffer: Buffer): unknown {
  const size = buffer.readUInt32BE(0);
  return decode(buffer.subarray(4, 4 + size));
}

describe('MuxClient', () => {
  it('negotiates protocol then correlates a binary MessagePack request and response', async () => {
    const stream = channel();
    const writes: Buffer[] = [];
    stream.stdin.on('data', (chunk) => writes.push(Buffer.from(chunk)));
    const client = new MuxClient(stream, 'project-a');

    client.open();
    const result = client.request<{ seed: Uint8Array }>('session.attach', { pane: 'pane-1' });

    expect(readFrame(writes[0]!)).toEqual({ protocol: 1 });
    const request = readFrame(writes[1]!) as {
      id: number;
      method: string;
      project_id: string;
      data: Uint8Array;
    };
    expect(request.method).toBe('session.attach');
    expect(request.project_id).toBe('project-a');
    expect(decode(request.data)).toEqual({ pane: 'pane-1' });
    stream.stdout.write(
      frame({ id: request.id, data: encode({ seed: new Uint8Array([0, 255, 128]) }) }),
    );

    const response = await result;
    expect(Buffer.from(response.seed)).toEqual(Buffer.from([0, 255, 128]));
  });

  it('rejects all pending work when the raw channel ends', async () => {
    const stream = channel();
    const client = new MuxClient(stream);
    client.open();
    const pending = client.request('pane.write', { data: new Uint8Array([0xff]) });

    stream.stdout.end();

    await expect(pending).rejects.toThrow(/channel ended/i);
  });

  it('delivers an unsolicited stolen-session event before the channel closes', () => {
    const stream = channel();
    const client = new MuxClient(stream);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    stream.stdout.write(
      frame({ event: 'session.stolen', session_id: 'session-1', by_kind: 'tty' }),
    );

    expect(events).toEqual([{ event: 'session.stolen', session_id: 'session-1', by_kind: 'tty' }]);
  });
});
