import { describe, it, expect } from 'vitest';
import { resolveLanguage, SUPPORTED_LANGS } from './languages';

describe('resolveLanguage', () => {
  const cases: Array<[string, string]> = [
    ['a.ts', 'typescript'],
    ['a.tsx', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['a.js', 'javascript'],
    ['a.jsx', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['Main.java', 'java'],
    ['a.py', 'python'],
    ['a.pyi', 'python'],
    ['a.rs', 'rust'],
    ['a.go', 'go'],
    ['index.html', 'html'],
    ['index.htm', 'html'],
    ['a.css', 'css'],
    ['package.json', 'json'],
    ['run.sh', 'shellscript'],
    ['.x.bash', 'shellscript'],
    ['prompt.zsh', 'shellscript'],
  ];

  it.each(cases)('maps %s -> %s', (path, lang) => {
    expect(resolveLanguage(path)).toBe(lang);
  });

  it('is case-insensitive on the extension', () => {
    expect(resolveLanguage('A.TS')).toBe('typescript');
    expect(resolveLanguage('Main.JAVA')).toBe('java');
  });

  it('resolves against the final extension on a dotted path', () => {
    expect(resolveLanguage('src/a.test.ts')).toBe('typescript');
    expect(resolveLanguage('/abs/path/to/mod.rs')).toBe('rust');
  });

  it('returns null for unknown, missing, or trailing-dot extensions', () => {
    expect(resolveLanguage('a.unknownext')).toBeNull();
    expect(resolveLanguage('README')).toBeNull();
    expect(resolveLanguage('Makefile')).toBeNull();
    expect(resolveLanguage('a.')).toBeNull();
  });

  it('advertises the full supported language set', () => {
    expect([...SUPPORTED_LANGS].sort()).toEqual(
      [
        'css',
        'go',
        'html',
        'java',
        'javascript',
        'json',
        'python',
        'rust',
        'shellscript',
        'typescript',
      ].sort(),
    );
  });
});
