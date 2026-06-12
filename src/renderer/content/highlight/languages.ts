import type { LanguageInput } from 'shiki/core';

/**
 * Pluggable language registry — the SINGLE authoring site that maps a file
 * extension to a Shiki TextMate grammar. Adding a future language is one entry
 * here (its extensions + the fine-grained grammar import); no other module in
 * the highlight pipeline needs to change.
 */
export type LangId =
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'python'
  | 'rust'
  | 'go'
  | 'html'
  | 'css'
  | 'json'
  | 'shellscript';

interface LangEntry {
  /** Lowercase file extensions (without the dot) that select this grammar. */
  exts: string[];
  /** Lazy grammar import — only fetched the first time the language is used.
   *  A dynamic `import()` is itself a valid Shiki `LanguageInput`. */
  load: () => LanguageInput;
}

const ENTRIES: Record<LangId, LangEntry> = {
  typescript: { exts: ['ts', 'tsx', 'mts', 'cts'], load: () => import('@shikijs/langs/typescript') },
  javascript: { exts: ['js', 'jsx', 'mjs', 'cjs'], load: () => import('@shikijs/langs/javascript') },
  java: { exts: ['java'], load: () => import('@shikijs/langs/java') },
  python: { exts: ['py', 'pyi'], load: () => import('@shikijs/langs/python') },
  rust: { exts: ['rs'], load: () => import('@shikijs/langs/rust') },
  go: { exts: ['go'], load: () => import('@shikijs/langs/go') },
  html: { exts: ['html', 'htm'], load: () => import('@shikijs/langs/html') },
  css: { exts: ['css'], load: () => import('@shikijs/langs/css') },
  json: { exts: ['json'], load: () => import('@shikijs/langs/json') },
  // One shell grammar (`shellscript`, aliases bash/sh/shell/zsh) covers all three.
  shellscript: { exts: ['sh', 'bash', 'zsh'], load: () => import('@shikijs/langs/shellscript') },
};

export const SUPPORTED_LANGS = Object.keys(ENTRIES) as LangId[];

const EXT_TO_LANG = new Map<string, LangId>();
for (const id of SUPPORTED_LANGS) {
  for (const ext of ENTRIES[id].exts) EXT_TO_LANG.set(ext, id);
}

/** Resolve a file path to a supported language, or `null` for plaintext fallback. */
export function resolveLanguage(filePath: string): LangId | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0 || dot === filePath.length - 1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG.get(ext) ?? null;
}

/** The lazy grammar loader for a language (used by the highlighter core). */
export function grammarLoader(id: LangId): () => LanguageInput {
  return ENTRIES[id].load;
}
