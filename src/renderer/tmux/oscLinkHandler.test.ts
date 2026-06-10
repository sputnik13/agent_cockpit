// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IBufferRange } from '@xterm/xterm';

vi.mock('../links/openLinkTarget', () => ({ openLinkTarget: vi.fn() }));

import { createOscLinkHandler } from './oscLinkHandler';
import { openLinkTarget } from '../links/openLinkTarget';

const RANGE = {} as IBufferRange;

beforeEach(() => {
  vi.mocked(openLinkTarget).mockReset();
});

describe('createOscLinkHandler', () => {
  it('routes OSC 8 activation through openLinkTarget with the terminal project', () => {
    const handler = createOscLinkHandler(() => 'p1');
    handler.activate(new MouseEvent('click'), 'https://example.com', RANGE);
    expect(openLinkTarget).toHaveBeenCalledWith('https://example.com', { projectId: 'p1' });
  });

  it('reads the project id lazily at click time', () => {
    let pid: string | null = null;
    const handler = createOscLinkHandler(() => pid);
    pid = 'p2';
    handler.activate(new MouseEvent('click'), 'file:///repo/a.ts', RANGE);
    expect(openLinkTarget).toHaveBeenCalledWith('file:///repo/a.ts', { projectId: 'p2' });
  });

  it('allows non-http protocols so file/path links reach activate', () => {
    expect(createOscLinkHandler(() => null).allowNonHttpProtocols).toBe(true);
  });
});
