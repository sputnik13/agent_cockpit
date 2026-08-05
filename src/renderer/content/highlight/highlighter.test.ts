import { describe, it, expect, afterEach } from 'vitest';
import { tokenizeLines, __resetHighlighterForTest } from './highlighter';
import { SUPPORTED_LANGS, type LangId } from './languages';

afterEach(__resetHighlighterForTest);

// A trivial but real snippet per language — enough for the grammar to load and
// emit tokens. This doubles as a registry-completeness guard: every advertised
// language must have a resolvable, loadable grammar (FR6).
const SNIPPETS: Record<LangId, string> = {
  typescript: 'const x: number = 1;',
  javascript: 'const x = 1;',
  java: 'class A { int x = 1; }',
  python: 'x = 1',
  rust: 'fn main() { let x = 1; }',
  go: 'package main\nfunc main() { x := 1 }',
  html: '<div class="a">hi</div>',
  css: '.a { color: red; }',
  json: '{ "a": 1, "b": [true, null] }',
  yaml: 'key: value\nlist:\n  - a\n  - b',
  shellscript: 'echo "$HOME"\nfor f in *; do :; done',
};

describe('tokenizeLines', () => {
  it('tokenizes a TypeScript sample into per-line colored tokens', async () => {
    const r = await tokenizeLines('const x = 1;\nfoo();', 'typescript', 'solarized-dark');
    expect(r.lines).toHaveLength(2);
    expect(r.lines.flat().some((t) => t.color)).toBe(true);
    // Round-trips the source.
    expect(r.lines.map((l) => l.map((t) => t.content).join('')).join('\n')).toBe(
      'const x = 1;\nfoo();',
    );
  });

  it('produces different default backgrounds for light vs dark themes', async () => {
    const dark = await tokenizeLines('x', 'typescript', 'solarized-dark');
    __resetHighlighterForTest();
    const light = await tokenizeLines('x', 'typescript', 'solarized-light');
    expect(dark.bg).not.toBe(light.bg);
  });

  it.each(SUPPORTED_LANGS)('loads and tokenizes the %s grammar', async (lang) => {
    const r = await tokenizeLines(SNIPPETS[lang], lang, 'solarized-dark');
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.flat().some((t) => t.color)).toBe(true);
  });

  it('content-addressed cache: same (code, lang, theme) returns the cached result', async () => {
    __resetHighlighterForTest();
    const first = await tokenizeLines('const x = 1;', 'typescript', 'solarized-dark');
    const second = await tokenizeLines('const x = 1;', 'typescript', 'solarized-dark');
    // Same object identity ⇒ served from cache, not re-tokenized.
    expect(second).toBe(first);
    // Different content recomputes (distinct object).
    const other = await tokenizeLines('const y = 2;', 'typescript', 'solarized-dark');
    expect(other).not.toBe(first);
    // The reset clears the cache, so the same input recomputes a fresh object.
    __resetHighlighterForTest();
    const afterReset = await tokenizeLines('const x = 1;', 'typescript', 'solarized-dark');
    expect(afterReset).not.toBe(first);
  });
});
