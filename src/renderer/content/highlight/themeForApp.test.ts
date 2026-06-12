import { describe, it, expect } from 'vitest';
import { shikiThemeFor, SHIKI_THEMES } from './themeForApp';

describe('shikiThemeFor', () => {
  it('maps app themes onto matching Shiki Solarized themes', () => {
    expect(shikiThemeFor('solarized-dark')).toBe('solarized-dark');
    expect(shikiThemeFor('solarized-light')).toBe('solarized-light');
  });

  it('pre-loads both themes so switching is instant', () => {
    expect([...SHIKI_THEMES].sort()).toEqual(['solarized-dark', 'solarized-light']);
  });
});
