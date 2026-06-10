import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const r = (p: string) => resolve(__dirname, p);

// Vitest needs the same path aliases as the electron-vite build. Tests are
// transpiled by esbuild, so this config governs module resolution for the
// shared/renderer/main TypeScript under test.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@renderer': r('src/renderer'),
      '@main': r('electron/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'remote-helper'],
  },
});
