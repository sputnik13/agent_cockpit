import type { TokenLine } from './highlight/highlighter';

/**
 * Map a 1-based source line number to the correct {@link TokenLine} entry.
 * Line numbers from parsePatch are 1-based; token arrays are 0-based. Returns
 * null when the line is absent or out of range. Pure — kept out of `DiffView`
 * so unit tests don't pull the renderer/IPC import chain.
 */
export function pickTokenLine(
  lineNumber: number | null,
  tokenLines: TokenLine[] | null,
): TokenLine | null {
  if (lineNumber === null || tokenLines === null) return null;
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= tokenLines.length) return null;
  return tokenLines[idx];
}
