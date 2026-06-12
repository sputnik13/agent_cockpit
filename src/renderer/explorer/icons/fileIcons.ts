import typescriptSvg from './svg/typescript.svg?raw';
import reactTsSvg from './svg/react_ts.svg?raw';
import javascriptSvg from './svg/javascript.svg?raw';
import reactSvg from './svg/react.svg?raw';
import jsonSvg from './svg/json.svg?raw';
import pythonSvg from './svg/python.svg?raw';
import rustSvg from './svg/rust.svg?raw';
import goSvg from './svg/go.svg?raw';
import htmlSvg from './svg/html.svg?raw';
import cssSvg from './svg/css.svg?raw';
import javaSvg from './svg/java.svg?raw';
import markdownSvg from './svg/markdown.svg?raw';
import yamlSvg from './svg/yaml.svg?raw';
import consoleSvg from './svg/console.svg?raw';
import tomlSvg from './svg/toml.svg?raw';
import gitSvg from './svg/git.svg?raw';
import dockerSvg from './svg/docker.svg?raw';
import imageSvg from './svg/image.svg?raw';
import lockSvg from './svg/lock.svg?raw';
import nodejsSvg from './svg/nodejs.svg?raw';
import tsconfigSvg from './svg/tsconfig.svg?raw';
import fileSvg from './svg/file.svg?raw';
import folderSvg from './svg/folder.svg?raw';
import folderOpenSvg from './svg/folder-open.svg?raw';

/**
 * Pluggable Explorer icon registry — the SINGLE authoring site that maps a file
 * name/extension to a vendored Material Icon Theme SVG. Adding a future filetype
 * icon is two steps: drop its SVG under `./svg/`, then add one import + one
 * mapping entry here; no other module in the Explorer needs to change.
 *
 * Mirrors the highlight-grammar registry pattern in
 * `src/renderer/content/highlight/languages.ts`.
 */
export type IconId =
  | 'typescript'
  | 'react_ts'
  | 'javascript'
  | 'react'
  | 'json'
  | 'python'
  | 'rust'
  | 'go'
  | 'html'
  | 'css'
  | 'java'
  | 'markdown'
  | 'yaml'
  | 'console'
  | 'toml'
  | 'git'
  | 'docker'
  | 'image'
  | 'lock'
  | 'nodejs'
  | 'tsconfig'
  | 'file'
  | 'folder'
  | 'folder-open';

/** Raw SVG markup for each icon id (vendored, trusted assets). */
const RAW: Record<IconId, string> = {
  typescript: typescriptSvg,
  react_ts: reactTsSvg,
  javascript: javascriptSvg,
  react: reactSvg,
  json: jsonSvg,
  python: pythonSvg,
  rust: rustSvg,
  go: goSvg,
  html: htmlSvg,
  css: cssSvg,
  java: javaSvg,
  markdown: markdownSvg,
  yaml: yamlSvg,
  console: consoleSvg,
  toml: tomlSvg,
  git: gitSvg,
  docker: dockerSvg,
  image: imageSvg,
  lock: lockSvg,
  nodejs: nodejsSvg,
  tsconfig: tsconfigSvg,
  file: fileSvg,
  folder: folderSvg,
  'folder-open': folderOpenSvg,
};

/**
 * Theme-tinted icons render in the app `text-dim` token (their SVG uses
 * `fill="currentColor"`); every other id is a brand logo rendered in its own
 * published colors.
 */
const TINTED = new Set<IconId>(['file', 'folder', 'folder-open']);

/** Exact lowercase filename → icon. Checked before the extension map. */
const NAME_TO_ICON: Record<string, IconId> = {
  'package.json': 'nodejs',
  'package-lock.json': 'lock',
  'dockerfile': 'docker',
  'cargo.toml': 'rust',
  'cargo.lock': 'lock',
  'go.mod': 'go',
  'go.sum': 'go',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitconfig': 'git',
};

/** Lowercase extension (no dot) → icon. */
const EXT_TO_ICON: Record<string, IconId> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react_ts',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  json: 'json',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  html: 'html',
  htm: 'html',
  css: 'css',
  java: 'java',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  toml: 'toml',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ico: 'image',
  bmp: 'image',
  lock: 'lock',
};

/**
 * Resolve a file's base name to an icon id. Resolution order: exact filename
 * (e.g. `package.json`), then the `tsconfig*.json` pattern, then file
 * extension, then the generic `file` fallback.
 */
export function resolveFileIcon(name: string): IconId {
  const lower = name.toLowerCase();

  const exact = NAME_TO_ICON[lower];
  if (exact) return exact;

  if (lower.startsWith('tsconfig') && lower.endsWith('.json')) return 'tsconfig';

  // dot > 0 skips dotfiles (e.g. `.env`), whose only dot is at index 0.
  const dot = lower.lastIndexOf('.');
  if (dot > 0 && dot < lower.length - 1) {
    const byExt = EXT_TO_ICON[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  return 'file';
}

/** Raw SVG markup for an icon id. */
export function getIconSvg(id: IconId): string {
  return RAW[id];
}

/** Whether an icon is theme-tinted (folders + the generic file) vs brand-colored. */
export function isTintedIcon(id: IconId): boolean {
  return TINTED.has(id);
}
