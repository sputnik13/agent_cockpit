import type { ContentKind } from './selectionStore';

export type ContentMode = 'diff' | 'rendered' | 'raw' | 'image' | 'html-preview';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const HTML_EXT = new Set(['.html', '.htm']);

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path));
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path));
}

export function isHtmlPath(path: string): boolean {
  return HTML_EXT.has(extOf(path));
}

/** Pick the default content mode by file extension. Explorer files ('file')
 *  default to raw rather than an empty diff. */
export function defaultModeFor(path: string, kind: ContentKind): ContentMode {
  if (isMarkdownPath(path)) return 'rendered';
  if (isHtmlPath(path)) return 'html-preview';
  if (isImagePath(path)) return 'image';
  return kind === 'change' ? 'diff' : 'raw';
}

/** The modes valid for a file: image files expose image+raw, markdown adds
 *  rendered, HTML adds a sandboxed preview, everything textual exposes diff+raw
 *  (+rendered where relevant). */
export function modesFor(path: string): ContentMode[] {
  if (isImagePath(path)) return ['image', 'raw'];
  if (isMarkdownPath(path)) return ['rendered', 'diff', 'raw'];
  if (isHtmlPath(path)) return ['html-preview', 'diff', 'raw'];
  return ['diff', 'raw'];
}

interface ModeSwitcherProps {
  available: ContentMode[];
  active: ContentMode;
  onChange: (m: ContentMode) => void;
}

const LABELS: Record<ContentMode, string> = {
  diff: 'Diff',
  rendered: 'Rendered',
  raw: 'Raw',
  image: 'Image',
  'html-preview': 'Preview',
};

/** Compact segmented control for switching content render modes. */
export function ModeSwitcher({ available, active, onChange }: ModeSwitcherProps): JSX.Element {
  return (
    <div role="tablist" aria-label="Content mode" style={{ display: 'flex', gap: 4 }}>
      {available.map((m) => {
        const isActive = m === active;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(m)}
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: isActive ? 'var(--accent)' : 'var(--bg-panel)',
              color: isActive ? 'white' : 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            {LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
