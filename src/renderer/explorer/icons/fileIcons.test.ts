import { describe, it, expect } from 'vitest';
import { getIconSvg, isTintedIcon, resolveFileIcon } from './fileIcons';

describe('resolveFileIcon', () => {
  it('matches exact filenames before extension', () => {
    expect(resolveFileIcon('package.json')).toBe('nodejs'); // not 'json'
    expect(resolveFileIcon('package-lock.json')).toBe('lock'); // not 'json'
    expect(resolveFileIcon('Cargo.toml')).toBe('rust'); // not 'toml'
    expect(resolveFileIcon('Cargo.lock')).toBe('lock');
    expect(resolveFileIcon('Dockerfile')).toBe('docker');
    expect(resolveFileIcon('go.mod')).toBe('go');
    expect(resolveFileIcon('.gitignore')).toBe('git');
  });

  it('matches the tsconfig*.json pattern', () => {
    expect(resolveFileIcon('tsconfig.json')).toBe('tsconfig');
    expect(resolveFileIcon('tsconfig.build.json')).toBe('tsconfig');
  });

  it('resolves by extension', () => {
    expect(resolveFileIcon('main.ts')).toBe('typescript');
    expect(resolveFileIcon('App.tsx')).toBe('react_ts');
    expect(resolveFileIcon('util.js')).toBe('javascript');
    expect(resolveFileIcon('Widget.jsx')).toBe('react');
    expect(resolveFileIcon('script.py')).toBe('python');
    expect(resolveFileIcon('lib.rs')).toBe('rust');
    expect(resolveFileIcon('run.sh')).toBe('console');
    expect(resolveFileIcon('logo.svg')).toBe('image');
  });

  it('is case-insensitive', () => {
    expect(resolveFileIcon('README.MD')).toBe('markdown');
    expect(resolveFileIcon('PACKAGE.JSON')).toBe('nodejs');
    expect(resolveFileIcon('PHOTO.PNG')).toBe('image');
  });

  it('falls back to the generic file icon', () => {
    expect(resolveFileIcon('mystery')).toBe('file');
    expect(resolveFileIcon('archive.zip')).toBe('file');
    expect(resolveFileIcon('.env')).toBe('file');
    expect(resolveFileIcon('trailingdot.')).toBe('file');
  });
});

describe('isTintedIcon', () => {
  it('tints only the folder and generic-file glyphs', () => {
    expect(isTintedIcon('file')).toBe(true);
    expect(isTintedIcon('folder')).toBe(true);
    expect(isTintedIcon('folder-open')).toBe(true);
    expect(isTintedIcon('typescript')).toBe(false);
    expect(isTintedIcon('python')).toBe(false);
  });
});

describe('getIconSvg', () => {
  it('returns raw SVG markup for an icon id', () => {
    expect(getIconSvg('typescript')).toContain('<svg');
    // tinted glyphs were normalized to currentColor at vendor time
    expect(getIconSvg('folder')).toContain('currentColor');
    expect(getIconSvg('file')).toContain('currentColor');
  });
});
