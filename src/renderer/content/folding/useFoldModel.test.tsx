// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { FoldFormat, FoldModel } from './foldModel';

const mockComputeFoldModel = vi.fn<(text: string, format: FoldFormat) => Promise<FoldModel>>();
vi.mock('./foldClient', () => ({
  computeFoldModel: (text: string, format: FoldFormat) => mockComputeFoldModel(text, format),
}));

import { useFoldModel } from './useFoldModel';

const emptyModel: FoldModel = { format: 'json', documents: [], regions: [], anchors: [], errors: [] };

beforeEach(() => {
  mockComputeFoldModel.mockReset();
});

describe('useFoldModel', () => {
  it('text === null short-circuits to unavailable with zero compute calls', async () => {
    const { result } = renderHook(() => useFoldModel(null, 'json'));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    expect(mockComputeFoldModel).not.toHaveBeenCalled();
  });

  it('format === null short-circuits to unavailable with zero compute calls', async () => {
    const { result } = renderHook(() => useFoldModel('{}', null));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    expect(mockComputeFoldModel).not.toHaveBeenCalled();
  });

  it('both null still short-circuits to unavailable with zero compute calls', async () => {
    const { result } = renderHook(() => useFoldModel(null, null));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    expect(mockComputeFoldModel).not.toHaveBeenCalled();
  });

  it('starts loading, then ready once the model resolves', async () => {
    mockComputeFoldModel.mockResolvedValue(emptyModel);
    const { result } = renderHook(() => useFoldModel('{}', 'json'));
    expect(result.current).toEqual({ state: 'loading' });
    await waitFor(() => expect(result.current).toEqual({ state: 'ready', model: emptyModel }));
    expect(mockComputeFoldModel).toHaveBeenCalledWith('{}', 'json');
  });

  it('a compute rejection resolves to unavailable (view falls back to plain/highlighted render)', async () => {
    mockComputeFoldModel.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useFoldModel('{}', 'json'));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
  });

  it('re-enters loading when text changes', async () => {
    mockComputeFoldModel.mockResolvedValue(emptyModel);
    const { result, rerender } = renderHook(({ text }: { text: string }) => useFoldModel(text, 'json'), {
      initialProps: { text: 'a' },
    });
    await waitFor(() => expect(result.current).toEqual({ state: 'ready', model: emptyModel }));

    mockComputeFoldModel.mockImplementation(() => new Promise(() => {})); // never resolves
    rerender({ text: 'b' });
    expect(result.current).toEqual({ state: 'loading' });
  });

  it('re-enters loading when format changes (same text)', async () => {
    mockComputeFoldModel.mockResolvedValue(emptyModel);
    const { result, rerender } = renderHook(({ format }: { format: FoldFormat }) => useFoldModel('a: 1', format), {
      initialProps: { format: 'yaml' as FoldFormat },
    });
    await waitFor(() => expect(result.current).toEqual({ state: 'ready', model: emptyModel }));

    mockComputeFoldModel.mockImplementation(() => new Promise(() => {})); // never resolves
    rerender({ format: 'json' as FoldFormat });
    expect(result.current).toEqual({ state: 'loading' });
  });

  it('a superseded in-flight result never applies once inputs change (stale-result guard)', async () => {
    let resolveFirst!: (m: FoldModel) => void;
    const first = new Promise<FoldModel>((r) => {
      resolveFirst = r;
    });
    const secondModel: FoldModel = { ...emptyModel, format: 'yaml' };

    mockComputeFoldModel.mockImplementationOnce(() => first);
    mockComputeFoldModel.mockImplementationOnce(() => Promise.resolve(secondModel));

    const { result, rerender } = renderHook(({ text }: { text: string }) => useFoldModel(text, 'json'), {
      initialProps: { text: 'a' },
    });
    rerender({ text: 'b' });

    // The second (current) call resolves first and applies.
    await waitFor(() => expect(result.current).toEqual({ state: 'ready', model: secondModel }));

    // The first (superseded) call resolves late; it must NOT clobber the
    // already-applied, current-input result.
    resolveFirst(emptyModel);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toEqual({ state: 'ready', model: secondModel });
  });

  it('unmounting mid-flight does not apply a late result (no act() warning, no throw)', async () => {
    let resolve!: (m: FoldModel) => void;
    mockComputeFoldModel.mockImplementationOnce(
      () =>
        new Promise<FoldModel>((r) => {
          resolve = r;
        }),
    );
    const { unmount } = renderHook(() => useFoldModel('{}', 'json'));
    unmount();
    expect(() => resolve(emptyModel)).not.toThrow();
  });
});
