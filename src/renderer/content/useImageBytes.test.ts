// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useImageBytes, mimeForImagePath, fmtImageSize } from './useImageBytes';

const readFileBytes = vi.fn();

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = {
  provider: { readFileBytes },
};

beforeEach(() => {
  readFileBytes.mockReset();
});

describe('mimeForImagePath', () => {
  it('maps every recognized image extension', () => {
    expect(mimeForImagePath('a.png')).toBe('image/png');
    expect(mimeForImagePath('a.jpg')).toBe('image/jpeg');
    expect(mimeForImagePath('a.jpeg')).toBe('image/jpeg');
    expect(mimeForImagePath('a.gif')).toBe('image/gif');
    expect(mimeForImagePath('a.webp')).toBe('image/webp');
    expect(mimeForImagePath('a.svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeForImagePath('A.PNG')).toBe('image/png');
  });

  it('returns null for an unrecognized or missing extension', () => {
    expect(mimeForImagePath('a.bmp')).toBeNull();
    expect(mimeForImagePath('no-extension-at-all')).toBeNull();
  });
});

describe('fmtImageSize', () => {
  it('formats bytes, KiB, and MiB', () => {
    expect(fmtImageSize(500)).toBe('500 B');
    expect(fmtImageSize(2048)).toBe('2.0 KiB');
    expect(fmtImageSize(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});

describe('useImageBytes', () => {
  it('starts loading, then shown with a data: URL once bytes resolve', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null });
    const { result } = renderHook(() => useImageBytes('a.png', '/wt'));
    expect(result.current.kind).toBe('loading');
    await waitFor(() => expect(result.current.kind).toBe('shown'));
    expect(result.current).toEqual({ kind: 'shown', url: 'data:image/png;base64,Zm9v' });
    expect(readFileBytes).toHaveBeenCalledWith('a.png', { worktreePath: '/wt' });
  });

  it('SVG bytes also resolve to a data: URL with the svg+xml MIME (still the <img> sink, never injected markup)', async () => {
    readFileBytes.mockResolvedValue({
      bytesBase64: 'PHN2Zy8+',
      sizeBytes: 8,
      exists: true,
      reason: null,
    });
    const { result } = renderHook(() => useImageBytes('icon.svg', '/wt'));
    await waitFor(() => expect(result.current.kind).toBe('shown'));
    expect(result.current).toEqual({ kind: 'shown', url: 'data:image/svg+xml;base64,PHN2Zy8+' });
  });

  it('an unrecognized extension degrades to unreadable WITHOUT calling readFileBytes', async () => {
    const { result } = renderHook(() => useImageBytes('a.bmp', '/wt'));
    await waitFor(() => expect(result.current.kind).toBe('unreadable'));
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it('reason "missing" -> absent (e.g. a deleted file\'s working-tree read)', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
    const { result } = renderHook(() => useImageBytes('gone.png', '/wt'));
    await waitFor(() => expect(result.current).toEqual({ kind: 'absent' }));
  });

  it('reason "too-large" -> too-large, carrying the real sizeBytes from FileBytesResult', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: null, sizeBytes: 12_582_912, exists: true, reason: 'too-large' });
    const { result } = renderHook(() => useImageBytes('huge.png', '/wt'));
    await waitFor(() => expect(result.current).toEqual({ kind: 'too-large', sizeBytes: 12_582_912 }));
  });

  it('reason "is-dir" -> unreadable (exists, but not a readable file)', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: null, sizeBytes: 0, exists: true, reason: 'is-dir' });
    const { result } = renderHook(() => useImageBytes('adir.png', '/wt'));
    await waitFor(() => expect(result.current.kind).toBe('unreadable'));
  });

  it('a rejected read -> unreadable (any read/transport error)', async () => {
    readFileBytes.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useImageBytes('bad.png', '/wt'));
    await waitFor(() => expect(result.current.kind).toBe('unreadable'));
  });

  it('a 0-byte file is shown (not absent) — branches on `reason === null`, never on bytesBase64 truthiness', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: '', sizeBytes: 0, exists: true, reason: null });
    const { result } = renderHook(() => useImageBytes('empty.png', '/wt'));
    await waitFor(() => expect(result.current).toEqual({ kind: 'shown', url: 'data:image/png;base64,' }));
  });

  it('passes worktreePath through unchanged (worktree-aware reads)', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: 'AAAA', sizeBytes: 3, exists: true, reason: null });
    renderHook(() => useImageBytes('a.png', '/repo/.worktrees/feature'));
    await waitFor(() =>
      expect(readFileBytes).toHaveBeenCalledWith('a.png', { worktreePath: '/repo/.worktrees/feature' }),
    );
  });

  it('re-fetches and resets to loading when path changes', async () => {
    readFileBytes.mockResolvedValue({ bytesBase64: 'AAAA', sizeBytes: 3, exists: true, reason: null });
    const { result, rerender } = renderHook(({ path, wt }: { path: string; wt: string }) => useImageBytes(path, wt), {
      initialProps: { path: 'a.png', wt: '/wt' },
    });
    await waitFor(() => expect(result.current.kind).toBe('shown'));

    readFileBytes.mockImplementation(() => new Promise(() => {})); // never resolves
    rerender({ path: 'b.png', wt: '/wt' });
    expect(result.current.kind).toBe('loading');
  });
});
