// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { NoteRecord } from '@shared/ipc/channels';
import { CodeRow } from './CodeRow';

afterEach(() => {
  cleanup();
});

/**
 * Focused unit tests for the shared plain-line row primitive — the ONE
 * authoring site for the Content-panel gutter-alignment invariant (CLAUDE.md
 * "Content-panel code views: line-number gutters stay aligned; wrap is a
 * toggle"). RawFile.tsx's `RawText` and FoldingView.tsx's `renderRow` are
 * exercised end-to-end by content.test.tsx / foldingView.test.tsx; this file
 * verifies the invariant once, directly against CodeRow's own DOM output,
 * plus the `beforeCode`/`children` composition contract both consumers rely
 * on positionally (`row.children[N]`).
 */

function baseProps(over: Partial<ComponentProps<typeof CodeRow>> = {}) {
  return {
    line: 1,
    wrap: false,
    notes: [] as NoteRecord[],
    composing: false,
    liveText: '',
    onAddNote: vi.fn(),
    onSubmitNote: vi.fn(),
    onCancelNote: vi.fn(),
    onDeleteNote: vi.fn(),
    ...over,
  };
}

function note(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 1,
    projectId: 'p1',
    targetKind: 'file',
    targetId: 'src/file.ts',
    body: 'note body',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    line: 3,
    anchorText: 'const a = 1;',
    ...over,
  };
}

describe('CodeRow', () => {
  describe('gutter-alignment invariant (CLAUDE.md)', () => {
    it('no-wrap: row is white-space:pre + minWidth:max-content; code span carries no wrap-mode override', () => {
      render(
        <CodeRow {...baseProps({ line: 1 })}>
          <span data-testid="code">const a = 1;</span>
        </CodeRow>,
      );
      const gutter = screen.getByTitle('Add a note on line 1');
      const row = gutter.parentElement as HTMLElement;
      expect(row.style.display).toBe('flex');
      expect(row.style.whiteSpace).toBe('pre');
      expect(row.style.minWidth).toBe('max-content');

      const codeSpan = row.children[1] as HTMLElement;
      expect(codeSpan.style.minWidth).toBe('');
      expect(codeSpan.style.overflowWrap).toBe('');
    });

    it('wrap: row is white-space:pre-wrap with no minWidth; code span gets minWidth:0 + overflowWrap:anywhere', () => {
      render(
        <CodeRow {...baseProps({ line: 1, wrap: true })}>
          <span data-testid="code">a noticeably longer line than the short one above it</span>
        </CodeRow>,
      );
      const gutter = screen.getByTitle('Add a note on line 1');
      const row = gutter.parentElement as HTMLElement;
      expect(row.style.whiteSpace).toBe('pre-wrap');
      expect(row.style.minWidth).toBe('');

      const codeSpan = row.children[1] as HTMLElement;
      expect(codeSpan.style.minWidth).toBe('0px');
      expect(codeSpan.style.overflowWrap).toBe('anywhere');
    });

    it('the gutter stays flexShrink:0 (shrink-0) in both wrap modes', () => {
      const { rerender } = render(
        <CodeRow {...baseProps({ line: 1, wrap: false })}>x</CodeRow>,
      );
      expect(screen.getByTitle('Add a note on line 1').className).toContain('shrink-0');

      rerender(<CodeRow {...baseProps({ line: 1, wrap: true })}>x</CodeRow>);
      expect(screen.getByTitle('Add a note on line 1').className).toContain('shrink-0');
    });

    it('the outer wrapper uses content-visibility:auto for off-screen row containment', () => {
      const { container } = render(<CodeRow {...baseProps({ line: 1 })}>x</CodeRow>);
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.style.contentVisibility).toBe('auto');
      expect(outer.style.containIntrinsicSize).toBe('auto 1.2em');
    });
  });

  describe('beforeCode slot / child-position contract', () => {
    it('without beforeCode: the row has exactly two direct children, [gutter, code span]', () => {
      render(
        <CodeRow {...baseProps({ line: 1 })}>
          <span data-testid="code">plain text</span>
        </CodeRow>,
      );
      const gutter = screen.getByTitle('Add a note on line 1');
      const row = gutter.parentElement as HTMLElement;
      expect(row.children).toHaveLength(2);
      expect(row.children[0]).toBe(gutter);
      expect(row.children[1]).toContainElement(screen.getByTestId('code'));
    });

    it('with beforeCode: it lands as an ADDITIONAL child strictly between the gutter and the code span', () => {
      render(
        <CodeRow
          {...baseProps({ line: 1 })}
          beforeCode={<span data-testid="toggle-slot">▸</span>}
        >
          <span data-testid="code">plain text</span>
        </CodeRow>,
      );
      const gutter = screen.getByTitle('Add a note on line 1');
      const row = gutter.parentElement as HTMLElement;
      expect(row.children).toHaveLength(3);
      expect(row.children[0]).toBe(gutter);
      expect(row.children[1]).toBe(screen.getByTestId('toggle-slot'));
      expect(row.children[2]).toContainElement(screen.getByTestId('code'));
    });
  });

  describe('note-thread composition', () => {
    it('renders no second element when there are no notes and the composer is closed', () => {
      const { container } = render(<CodeRow {...baseProps({ line: 1 })}>x</CodeRow>);
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.children).toHaveLength(1); // just the flex row
    });

    it('renders the thread as a second element when notes are present', () => {
      const { container } = render(
        <CodeRow {...baseProps({ line: 3, notes: [note()], liveText: 'const a = 1;' })}>x</CodeRow>,
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.children).toHaveLength(2);
      expect(screen.getByText('note body')).toBeInTheDocument();
    });

    it('renders the (empty) composer as a second element when composing is true, even with zero notes', () => {
      const { container } = render(
        <CodeRow {...baseProps({ line: 1, composing: true })}>x</CodeRow>,
      );
      const outer = container.firstElementChild as HTMLElement;
      expect(outer.children).toHaveLength(2);
      expect(screen.getByPlaceholderText('Add a note for this line…')).toBeInTheDocument();
    });
  });

  describe('callback wiring', () => {
    it('clicking the gutter calls onAddNote with this row\'s line', () => {
      const onAddNote = vi.fn();
      render(<CodeRow {...baseProps({ line: 7, onAddNote })}>x</CodeRow>);
      fireEvent.click(screen.getByTitle('Add a note on line 7'));
      expect(onAddNote).toHaveBeenCalledWith(7);
    });

    it('deleting an existing note calls onDeleteNote with its id', () => {
      const onDeleteNote = vi.fn();
      render(
        <CodeRow
          {...baseProps({
            line: 3,
            notes: [note({ id: 42 })],
            liveText: 'const a = 1;',
            onDeleteNote,
          })}
        >
          x
        </CodeRow>,
      );
      fireEvent.click(screen.getByLabelText('Delete note'));
      expect(onDeleteNote).toHaveBeenCalledWith(42);
    });

    it('submitting the composer calls onSubmitNote with the drafted body', () => {
      const onSubmitNote = vi.fn();
      render(
        <CodeRow {...baseProps({ line: 1, composing: true, onSubmitNote })}>x</CodeRow>,
      );
      fireEvent.change(screen.getByPlaceholderText('Add a note for this line…'), {
        target: { value: 'a new note' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      expect(onSubmitNote).toHaveBeenCalledWith('a new note');
    });

    it('cancelling the composer calls onCancelNote', () => {
      const onCancelNote = vi.fn();
      render(<CodeRow {...baseProps({ line: 1, composing: true, onCancelNote })}>x</CodeRow>);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onCancelNote).toHaveBeenCalled();
    });
  });

  describe('code span content', () => {
    it('renders exactly the given children, unmodified', () => {
      render(
        <CodeRow {...baseProps({ line: 1 })}>
          <em data-testid="custom-content">hi</em>
        </CodeRow>,
      );
      expect(screen.getByTestId('custom-content')).toHaveTextContent('hi');
    });
  });
});
