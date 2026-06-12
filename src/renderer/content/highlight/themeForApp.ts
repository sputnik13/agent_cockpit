import type { ThemeId } from '@shared/settings';

/**
 * Map the app's `ThemeId` onto a Shiki theme name. Shiki ships Solarized
 * themes whose names match our palette 1:1, so highlighting tracks the app's
 * light/dark setting with no custom theme authoring.
 */
export type ShikiThemeName = 'solarized-dark' | 'solarized-light';

/** Both themes are pre-loaded into the highlighter so switching is instant. */
export const SHIKI_THEMES: ShikiThemeName[] = ['solarized-dark', 'solarized-light'];

export function shikiThemeFor(theme: ThemeId): ShikiThemeName {
  return theme === 'solarized-light' ? 'solarized-light' : 'solarized-dark';
}
