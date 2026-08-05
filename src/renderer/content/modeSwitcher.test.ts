import { describe, it, expect } from 'vitest';
import {
  classOf,
  defaultModeFor,
  isHtmlPath,
  isImagePath,
  isJsonPath,
  isMarkdownPath,
  isYamlPath,
  modesFor,
  viewFor,
} from './modeSwitcher';

describe('classOf (pure, path-only classification)', () => {
  it('classifies markdown extensions', () => {
    expect(classOf('README.md')).toBe('markdown');
    expect(classOf('notes.markdown')).toBe('markdown');
    expect(classOf('doc.mdx')).toBe('markdown');
  });

  it('classifies html extensions', () => {
    expect(classOf('index.html')).toBe('html');
    expect(classOf('mockup.htm')).toBe('html');
  });

  it('classifies image extensions', () => {
    expect(classOf('logo.png')).toBe('image');
    expect(classOf('photo.jpeg')).toBe('image');
    expect(classOf('icon.svg')).toBe('image');
  });

  it('classifies an ordinary source file as text', () => {
    expect(classOf('src/index.ts')).toBe('text');
  });

  it('classifies json extensions, including jsonc but not json5 — json is now its own class (see the module doc comment for the .jsonc/.json5 decision), not text', () => {
    expect(classOf('package.json')).toBe('json');
    expect(classOf('tsconfig.jsonc')).toBe('json');
    // .json5 is a materially different grammar jsonc-parser does not parse
    // — deliberately falls through to 'text', unchanged from today.
    expect(classOf('data.json5')).toBe('text');
  });

  it('classifies yaml extensions as their own class, not text', () => {
    expect(classOf('config.yaml')).toBe('yaml');
    expect(classOf('config.yml')).toBe('yaml');
  });

  it('classifies an unknown/binary extension as text — unknown-at-classification-time, never a guessed generic-binary (classOf is pure/path-only and stays that way; runtime reclassification happens one layer up, in ContentViewer — see the module doc comment)', () => {
    expect(classOf('archive.pdf')).toBe('text');
    expect(classOf('bundle.zip')).toBe('text');
    expect(classOf('no-extension-at-all')).toBe('text');
  });
});

describe('modesFor (availability table)', () => {
  it('markdown: diff, rendered, raw', () => {
    expect(modesFor('README.md', 'change')).toEqual(['diff', 'rendered', 'raw']);
    expect(modesFor('README.md', 'file')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('html: diff, rendered, raw', () => {
    expect(modesFor('mockup.html', 'change')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('image: diff, rendered — no raw', () => {
    expect(modesFor('assets/logo.png', 'change')).toEqual(['diff', 'rendered']);
    expect(modesFor('assets/logo.png', 'file')).toEqual(['diff', 'rendered']);
  });

  it('a source file: diff, rendered, raw', () => {
    expect(modesFor('src/index.ts', 'change')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('a JSON file: diff, rendered, raw (own class now, not text — see classOf)', () => {
    expect(modesFor('package.json', 'file')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('a YAML file: diff, rendered, raw (same availability as json/text)', () => {
    expect(modesFor('config.yaml', 'file')).toEqual(['diff', 'rendered', 'raw']);
    expect(modesFor('config.yml', 'change')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('an unknown/binary extension: diff, rendered, raw — same as any other text-like file today (RawFile/DiffView already tolerate real binary content at runtime)', () => {
    expect(modesFor('archive.pdf', 'change')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('external-file selection: never offers diff (no git baseline)', () => {
    expect(modesFor('src/index.ts', 'external-file')).toEqual(['rendered', 'raw']);
    expect(modesFor('README.md', 'external-file')).toEqual(['rendered', 'raw']);
    expect(modesFor('mockup.html', 'external-file')).toEqual(['rendered', 'raw']);
    expect(modesFor('data.json', 'external-file')).toEqual(['rendered', 'raw']);
    expect(modesFor('config.yaml', 'external-file')).toEqual(['rendered', 'raw']);
  });

  it('external-file image/generic-binary: raw only (no baseline-free comparison view exists yet — matches today)', () => {
    expect(modesFor('assets/logo.png', 'external-file')).toEqual(['raw']);
  });
});

describe('defaultModeFor', () => {
  it('markdown always defaults to rendered, regardless of kind', () => {
    expect(defaultModeFor('README.md', 'change')).toBe('rendered');
    expect(defaultModeFor('README.md', 'file')).toBe('rendered');
    expect(defaultModeFor('README.md', 'external-file')).toBe('rendered');
  });

  it('html always defaults to rendered, regardless of kind', () => {
    expect(defaultModeFor('mockup.html', 'change')).toBe('rendered');
    expect(defaultModeFor('mockup.html', 'file')).toBe('rendered');
  });

  it('image defaults to diff regardless of kind (today\'s unconditional comparison view, now under the Diff mode name)', () => {
    expect(defaultModeFor('assets/logo.png', 'change')).toBe('diff');
    expect(defaultModeFor('assets/logo.png', 'file')).toBe('diff');
  });

  it('a source file defaults to diff for a change, raw for a file (never an empty diff)', () => {
    expect(defaultModeFor('src/index.ts', 'change')).toBe('diff');
    expect(defaultModeFor('src/index.ts', 'file')).toBe('raw');
  });

  it('a JSON file defaults to diff for a change, raw for a file (own class now, not text)', () => {
    expect(defaultModeFor('package.json', 'change')).toBe('diff');
    expect(defaultModeFor('package.json', 'file')).toBe('raw');
  });

  it('a YAML file defaults to diff for a change, raw for a file (same as json/text)', () => {
    expect(defaultModeFor('config.yaml', 'change')).toBe('diff');
    expect(defaultModeFor('config.yaml', 'file')).toBe('raw');
  });

  it('an unknown/binary extension defaults like any other text-like file', () => {
    expect(defaultModeFor('archive.pdf', 'change')).toBe('diff');
    expect(defaultModeFor('archive.pdf', 'file')).toBe('raw');
  });

  it('external-file never defaults to diff (no git baseline)', () => {
    expect(defaultModeFor('src/index.ts', 'external-file')).toBe('raw');
    expect(defaultModeFor('assets/logo.png', 'external-file')).toBe('raw');
    expect(defaultModeFor('data.json', 'external-file')).toBe('raw');
    expect(defaultModeFor('config.yaml', 'external-file')).toBe('raw');
  });
});

describe('viewFor — the (class, mode) -> component dispatch table', () => {
  it('markdown', () => {
    expect(viewFor('markdown', 'diff')).toBe('diff-view');
    expect(viewFor('markdown', 'rendered')).toBe('rendered-markdown');
    expect(viewFor('markdown', 'raw')).toBe('raw-file');
  });

  it('html', () => {
    expect(viewFor('html', 'diff')).toBe('diff-view');
    expect(viewFor('html', 'rendered')).toBe('html-preview');
    expect(viewFor('html', 'raw')).toBe('raw-file');
  });

  it('text (other-text-like)', () => {
    expect(viewFor('text', 'diff')).toBe('diff-view');
    // Both dispatch to RawFile by design — the Rendered/Raw split is a
    // runtime `highlight` prop ContentViewer passes, not a separate ViewKind.
    expect(viewFor('text', 'rendered')).toBe('raw-file');
    expect(viewFor('text', 'raw')).toBe('raw-file');
  });

  it('json', () => {
    expect(viewFor('json', 'diff')).toBe('diff-view');
    // The one new cell this leaf introduces: Rendered dispatches to
    // FoldingView (a temporary RawFile pass-through — see FoldingView.tsx),
    // not directly to raw-file the way 'text' still does.
    expect(viewFor('json', 'rendered')).toBe('folding-view');
    expect(viewFor('json', 'raw')).toBe('raw-file');
  });

  it('yaml', () => {
    expect(viewFor('yaml', 'diff')).toBe('diff-view');
    expect(viewFor('yaml', 'rendered')).toBe('folding-view');
    expect(viewFor('yaml', 'raw')).toBe('raw-file');
  });

  it('image', () => {
    expect(viewFor('image', 'diff')).toBe('image-compare');
    // ImageView: the single-image Rendered view (resolved by
    // local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.4).
    expect(viewFor('image', 'rendered')).toBe('image-view');
    // Only reachable via the external-file carve-out; renders RawFile's
    // binary fallback, same as today.
    expect(viewFor('image', 'raw')).toBe('raw-file');
  });

  it('generic-binary', () => {
    // Reachable once ContentViewer's effective class is 'generic-binary' (a
    // runtime-confirmed binary file — see the module doc comment). Both
    // diff/rendered reuse the SAME components as 'text' above: DiffView
    // already renders the binary-diff placeholder itself (parsePatch.ts's
    // `binary` field), and RawFile already renders the graceful placeholder
    // when `highlight` (Rendered) is true.
    expect(viewFor('generic-binary', 'diff')).toBe('diff-view');
    expect(viewFor('generic-binary', 'rendered')).toBe('raw-file');
    expect(viewFor('generic-binary', 'raw')).toBe('raw-file');
  });
});

describe('modesFor / defaultModeFor with knownBinary (runtime reclassification override)', () => {
  it('modesFor: knownBinary=true forces generic-binary availability regardless of extension', () => {
    expect(modesFor('archive.pdf', 'change', true)).toEqual(['diff', 'rendered']);
    expect(modesFor('archive.pdf', 'file', true)).toEqual(['diff', 'rendered']);
    // Even a recognized extension is overridden once runtime-confirmed binary.
    expect(modesFor('src/index.ts', 'change', true)).toEqual(['diff', 'rendered']);
    // ... and json/yaml are no exception, despite now being their own classes.
    expect(modesFor('data.json', 'change', true)).toEqual(['diff', 'rendered']);
    expect(modesFor('config.yaml', 'change', true)).toEqual(['diff', 'rendered']);
  });

  it('modesFor: external-file + knownBinary still falls back to raw only, same as image', () => {
    expect(modesFor('archive.pdf', 'external-file', true)).toEqual(['raw']);
  });

  it('modesFor: omitted/false knownBinary is identical to the 2-arg call (no regression)', () => {
    expect(modesFor('archive.pdf', 'change')).toEqual(modesFor('archive.pdf', 'change', false));
    expect(modesFor('archive.pdf', 'change')).toEqual(['diff', 'rendered', 'raw']);
  });

  it('defaultModeFor: knownBinary=true defaults to diff (change or file), matching generic-binary', () => {
    expect(defaultModeFor('archive.pdf', 'change', true)).toBe('diff');
    expect(defaultModeFor('archive.pdf', 'file', true)).toBe('diff');
  });

  it('defaultModeFor: external-file + knownBinary still defaults to raw (no baseline)', () => {
    expect(defaultModeFor('archive.pdf', 'external-file', true)).toBe('raw');
  });

  it('defaultModeFor: omitted/false knownBinary is identical to the 2-arg call (no regression)', () => {
    expect(defaultModeFor('archive.pdf', 'file')).toBe(defaultModeFor('archive.pdf', 'file', false));
    expect(defaultModeFor('archive.pdf', 'file')).toBe('raw');
  });
});

describe('path predicates (still exported; classOf composes them)', () => {
  it('isMarkdownPath', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.ts')).toBe(false);
  });

  it('isHtmlPath', () => {
    expect(isHtmlPath('a.html')).toBe(true);
    expect(isHtmlPath('a.htm')).toBe(true);
    expect(isHtmlPath('a.ts')).toBe(false);
  });

  it('isImagePath', () => {
    expect(isImagePath('a.png')).toBe(true);
    expect(isImagePath('a.ts')).toBe(false);
  });

  it('isJsonPath', () => {
    expect(isJsonPath('a.json')).toBe(true);
    expect(isJsonPath('a.jsonc')).toBe(true);
    expect(isJsonPath('a.json5')).toBe(false);
    expect(isJsonPath('a.ts')).toBe(false);
  });

  it('isYamlPath', () => {
    expect(isYamlPath('a.yaml')).toBe(true);
    expect(isYamlPath('a.yml')).toBe(true);
    expect(isYamlPath('a.ts')).toBe(false);
  });
});
