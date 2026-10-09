import type { ITheme } from '@xterm/xterm';
import type { ThemeId } from '@shared/settings';

/** Concrete terminal palettes shared by xterm and the wterm Ghostty adapter. */
export const XTERM_THEMES: Record<ThemeId, ITheme> = {
  'solarized-dark': {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#0d4150',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'solarized-light': {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};
