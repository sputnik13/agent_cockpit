// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({ muxScrollbackLines: vi.fn() }));
vi.mock('./terminalRegistry', () => ({ muxScrollbackLines: h.muxScrollbackLines }));

import { MuxCopyOverlay, sgrStyle } from './MuxCopyOverlay';

afterEach(() => {
  cleanup();
  h.muxScrollbackLines.mockReset();
});

describe('MuxCopyOverlay', () => {
  it('renders daemon style runs with indexed and RGB SGR colors', () => {
    expect(sgrStyle('1;4;38;5;1;48;2;1;2;3')).toMatchObject({
      fontWeight: 700,
      textDecorationLine: 'underline',
      color: '#dc322f',
      backgroundColor: 'rgb(1, 2, 3)',
    });
    expect(sgrStyle('3;9;38;2;7;8;9')).toMatchObject({
      fontStyle: 'italic',
      textDecorationLine: 'line-through',
      color: 'rgb(7, 8, 9)',
    });
  });

  it('pages through materialized history and returns to newer lines', async () => {
    h.muxScrollbackLines.mockImplementation(async (_projectId, _kind, _key, offset: number) =>
      (offset === 0 ? Array.from({ length: 200 }, (_, index) => `line ${index}`) : ['older line'])
        .map((text, line) => ({ line, runs: [{ text, sgr: '' }] })),
    );
    render(<MuxCopyOverlay projectId="p1" terminalKey="t1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('line 0')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(h.muxScrollbackLines).toHaveBeenLastCalledWith('p1', 'terminal', 't1', 200, 200));
    expect(screen.getByText('older line')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    await waitFor(() => expect(h.muxScrollbackLines).toHaveBeenLastCalledWith('p1', 'terminal', 't1', 0, 200));
  });

  it('copies the rendered page and closes on Escape', async () => {
    h.muxScrollbackLines.mockResolvedValue([
      { line: 0, runs: [{ text: 'one', sgr: '' }] },
      { line: 1, runs: [{ text: 'two', sgr: '' }] },
    ]);
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const onClose = vi.fn();
    render(<MuxCopyOverlay projectId="p1" terminalKey="t1" onClose={onClose} />);

    await waitFor(() => expect(screen.getByText('one')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Copy page' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('one\ntwo'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('pages history from the keyboard', async () => {
    h.muxScrollbackLines.mockImplementation(async (_projectId, _kind, _key, offset: number) =>
      (offset === 0 ? Array.from({ length: 200 }, (_, index) => `line ${index}`) : ['older line'])
        .map((text, line) => ({ line, runs: [{ text, sgr: '' }] })),
    );
    render(<MuxCopyOverlay projectId="p1" terminalKey="t1" onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: 'PageUp' });
    await waitFor(() => expect(h.muxScrollbackLines).toHaveBeenLastCalledWith('p1', 'terminal', 't1', 200, 200));
    fireEvent.keyDown(window, { key: 'PageDown' });
    await waitFor(() => expect(h.muxScrollbackLines).toHaveBeenLastCalledWith('p1', 'terminal', 't1', 0, 200));
  });
});
