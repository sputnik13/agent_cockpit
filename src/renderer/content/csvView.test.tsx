// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { CsvView } from './CsvView';

const readFile = vi.fn();
(window as unknown as { api: unknown }).api = { provider: { readFile } };

function textFile(content: string): void {
  readFile.mockResolvedValue({
    content,
    truncated: false,
    isBinary: false,
    sizeBytes: content.length,
  });
}

const CSV = 'name,age\nbob,30\nalice,4\ncarol,100\n';

function renderView(
  props: Partial<React.ComponentProps<typeof CsvView>> = {},
): ReturnType<typeof render> {
  return render(
    <CsvView worktreePath="/wt" filePath="d.csv" delimiter="," maxBytes={1000} {...props} />,
  );
}

const bodyNames = (): string[] =>
  screen
    .getAllByRole('cell')
    .filter((_, i, all) => i % 2 === 0 && i < all.length)
    .map((c) => c.textContent ?? '');

describe('CsvView', () => {
  beforeEach(() => readFile.mockReset());
  afterEach(cleanup);

  it('reads with the memory-derived cap and renders header + rows + counts', async () => {
    textFile(CSV);
    renderView({ maxBytes: 4242 });
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith('d.csv', { worktreePath: '/wt', maxBytes: 4242 });
    expect(screen.getByRole('columnheader', { name: /name/ })).toBeInTheDocument();
    expect(screen.getByTestId('csv-row-count')).toHaveTextContent('3 rows · 2 columns');
  });

  it('parses a tab-delimited file when given the tab delimiter', async () => {
    textFile('a\tb\nx\ty\n');
    renderView({ delimiter: '\t' });
    expect(await screen.findByText('y')).toBeInTheDocument();
    expect(screen.getByTestId('csv-row-count')).toHaveTextContent('1 rows · 2 columns');
  });

  it('sorts on header click: asc, desc, then back to source order (numeric column)', async () => {
    textFile(CSV);
    renderView();
    await screen.findByText('bob');
    const age = screen.getByRole('columnheader', { name: /age/ });

    fireEvent.click(age);
    await waitFor(() => expect(bodyNames()).toEqual(['alice', 'bob', 'carol']));
    expect(age).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(age);
    await waitFor(() => expect(bodyNames()).toEqual(['carol', 'bob', 'alice']));
    expect(age).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(age);
    await waitFor(() => expect(bodyNames()).toEqual(['bob', 'alice', 'carol']));
    expect(age).toHaveAttribute('aria-sort', 'none');
  });

  it('filters rows (debounced) and reports the filtered count; empty result is explained', async () => {
    textFile(CSV);
    renderView();
    await screen.findByText('bob');
    const box = screen.getByLabelText('Filter rows');

    fireEvent.change(box, { target: { value: 'AL' } });
    await waitFor(() =>
      expect(screen.getByTestId('csv-row-count')).toHaveTextContent('1 of 3 rows'),
    );
    expect(bodyNames()).toEqual(['alice']);

    fireEvent.change(box, { target: { value: 'nomatch' } });
    expect(await screen.findByText('No rows match the filter.')).toBeInTheDocument();
  });

  it('virtualizes: a large file renders only a window of rows, not all of them', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `r${i},${i}`).join('\n');
    textFile(`k,v\n${rows}\n`);
    renderView({ maxBytes: 10_000_000 });
    await screen.findByText('r0');
    expect(screen.getByTestId('csv-row-count')).toHaveTextContent('5,000 rows');
    expect(screen.getAllByRole('row').length).toBeLessThan(80);
  });

  it('over the memory budget: shows a notice, parses nothing, and does NOT report too-large upward', async () => {
    readFile.mockResolvedValue({
      content: null,
      truncated: true,
      isBinary: false,
      sizeBytes: 5_000_000,
    });
    const onBinaryConfirmed = vi.fn();
    renderView({ maxBytes: 1024, onBinaryConfirmed });
    expect(await screen.findByText('Too large for the table view')).toBeInTheDocument();
    expect(screen.getByText(/4\.8 MiB.*1\.0 KiB/)).toBeInTheDocument();
    expect(onBinaryConfirmed).not.toHaveBeenCalled();
  });

  it('reports text, binary and missing outcomes through onBinaryConfirmed', async () => {
    const onBinaryConfirmed = vi.fn();
    textFile(CSV);
    renderView({ onBinaryConfirmed });
    await screen.findByText('bob');
    expect(onBinaryConfirmed).toHaveBeenCalledWith({ kind: 'text', sizeBytes: CSV.length });
    cleanup();

    readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 9 });
    const onBinary = vi.fn();
    renderView({ onBinaryConfirmed: onBinary });
    await waitFor(() => expect(onBinary).toHaveBeenCalledWith({ kind: 'binary', sizeBytes: 9 }));
    cleanup();

    readFile.mockResolvedValue({ content: null, truncated: false, isBinary: false, sizeBytes: 0 });
    const onMissing = vi.fn();
    renderView({ onBinaryConfirmed: onMissing });
    await waitFor(() => expect(onMissing).toHaveBeenCalledWith({ kind: 'missing' }));
  });

  it('passes gitRef through as the read ref', async () => {
    textFile(CSV);
    renderView({ gitRef: 'HEAD' });
    await screen.findByText('bob');
    expect(readFile).toHaveBeenCalledWith('d.csv', expect.objectContaining({ ref: 'HEAD' }));
  });

  it('a failed read shows an error state instead of hanging', async () => {
    // A plain function, not the `vi.fn()` spy: the spy attaches its own
    // handler to the promise it returns to record settled results, and that
    // derived promise is reported as an unhandled rejection even though the
    // component under test handles the original.
    const api = (window as unknown as { api: { provider: { readFile: unknown } } }).api;
    const spy = api.provider.readFile;
    api.provider.readFile = () => Promise.reject(new Error('boom'));
    try {
      renderView();
      expect(await screen.findByText("Couldn't open this file as a table")).toBeInTheDocument();
      expect(screen.getByText('boom')).toBeInTheDocument();
    } finally {
      api.provider.readFile = spy;
    }
  });
});
