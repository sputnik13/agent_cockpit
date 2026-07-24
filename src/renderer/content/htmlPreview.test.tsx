// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ContentSelection } from './selectionStore';
import { useContentSelection } from './selectionStore';
import { defaultModeFor, isHtmlPath, modesFor } from './modeSwitcher';
import { PREVIEW_CSP, injectPreviewCsp } from './HtmlPreview';

const { getFileDiff, getDiffBundle, readFile } = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  getDiffBundle: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../providerClient', () => ({
  agentCockpit: {
    provider: { getFileDiff, getDiffBundle, readFile },
    notes: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      exportMarkdown: vi.fn().mockResolvedValue(''),
    },
  },
  useProjectsStore: Object.assign(
    (sel: (s: { activeId: string | null }) => unknown) => sel({ activeId: 'p1' }),
    { getState: () => ({ activeId: 'p1' }) },
  ),
}));

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = {
  provider: { getFileDiff, getDiffBundle, readFile },
};

import { ContentViewer } from './ContentViewer';

function sel(path: string, over: Partial<ContentSelection> = {}): ContentSelection {
  return { path, worktreePath: '/wt', kind: 'change', ...over };
}

describe('modeSwitcher html support', () => {
  it('recognizes .html and .htm', () => {
    expect(isHtmlPath('page.html')).toBe(true);
    expect(isHtmlPath('MOCKUP.HTM')).toBe(true);
    expect(isHtmlPath('notes.md')).toBe(false);
    expect(isHtmlPath('script.ts')).toBe(false);
  });

  it('defaults html files to the sandboxed preview', () => {
    expect(defaultModeFor('mockup.html', 'change')).toBe('html-preview');
    expect(defaultModeFor('mockup.htm', 'file')).toBe('html-preview');
  });

  it('offers preview + diff + raw for html files', () => {
    expect(modesFor('mockup.html')).toEqual(['html-preview', 'diff', 'raw']);
  });
});

describe('injectPreviewCsp', () => {
  it('injects the egress CSP as the first head child', () => {
    const out = injectPreviewCsp('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`);
    // meta lands immediately after <head>, before the existing <title>.
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
  });

  it('synthesizes a head when the source omits one', () => {
    const out = injectPreviewCsp('<body>just a fragment</body>');
    expect(out).toContain(`content="${PREVIEW_CSP}"`);
    expect(out).toContain('just a fragment');
  });

  it('blocks network egress by default (default-src none, no remote origins)', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).not.toMatch(/https?:/);
  });
});

describe('HtmlPreview in ContentViewer', () => {
  let created: string[];
  let revoked: string[];

  beforeEach(() => {
    getFileDiff.mockReset();
    getDiffBundle.mockReset();
    readFile.mockReset();
    getDiffBundle.mockResolvedValue({ patch: '', oldContent: null, newContent: null });
    readFile.mockResolvedValue({
      content: '<html><body><h1>Mock</h1></body></html>',
      truncated: false,
      isBinary: false,
      sizeBytes: 40,
    });
    created = [];
    revoked = [];
    let n = 0;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
      const url = `blob:mock/${n++}`;
      created.push(url);
      return url;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => {
      revoked.push(u);
    };
  });

  afterEach(() => {
    cleanup();
    useContentSelection.setState({ selections: {} });
  });

  it('defaults an .html change to the Preview tab and renders a sandboxed blob iframe', async () => {
    render(<ContentViewer selection={sel('mockup.html')} />);

    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');

    const iframe = (await screen.findByTitle('HTML preview')) as HTMLIFrameElement;
    // sandbox present, empty (deny all) — and crucially NEVER allow-same-origin.
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-same-origin');
    // The iframe remounts once the blob URL is ready (keyed on it), so re-query.
    await waitFor(() =>
      expect((screen.getByTitle('HTML preview') as HTMLIFrameElement).getAttribute('src')).toMatch(
        /^blob:/,
      ),
    );
    expect(created.length).toBeGreaterThan(0);
    // The file's working-tree content is read (no git ref).
    expect(readFile).toHaveBeenCalledWith('mockup.html', { worktreePath: '/wt' });
  });

  it('revokes the blob URL on unmount (no object-URL leak)', async () => {
    const { unmount } = render(<ContentViewer selection={sel('a.html')} />);
    await waitFor(() =>
      expect((screen.getByTitle('HTML preview') as HTMLIFrameElement).getAttribute('src')).toMatch(
        /^blob:/,
      ),
    );
    const first = created[0];
    expect(revoked).not.toContain(first);

    unmount();
    expect(revoked).toContain(first);
  });

  it('never grants the iframe scripts or same-origin (static v1)', async () => {
    render(<ContentViewer selection={sel('mockup.html')} />);
    const iframe = (await screen.findByTitle('HTML preview')) as HTMLIFrameElement;
    // v1 is static-only: sandbox stays "" (deny all). No "Run scripts" control.
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox') ?? '').not.toContain('allow-same-origin');
    expect(screen.queryByRole('button', { name: 'Run scripts' })).not.toBeInTheDocument();
  });
});
