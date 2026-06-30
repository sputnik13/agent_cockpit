import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@main': r('electron/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: r('electron/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: r('electron/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@renderer': r('src/renderer'),
      },
    },
    // @wterm/ghostty loads its libghostty WASM via
    // `new URL("../wasm/ghostty-vt.wasm", import.meta.url)`. Exclude it from
    // esbuild dep pre-bundling so that URL (and the asset emit into the build) is
    // handled by Vite/Rollup's asset pipeline — same-origin, packaged into the
    // distributable, never network-fetched — rather than rewritten by esbuild.
    optimizeDeps: {
      exclude: ['@wterm/ghostty'],
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),
          diagnostics: r('src/renderer/diagnostics.html'),
        },
      },
    },
    // The syntax-highlight tokenize worker (highlight/tokenizeWorker) lazy-imports
    // Shiki grammars/themes via dynamic import(), which only works in an ES-module
    // worker — Vite's default build worker format is 'iife' (no import()), so pin
    // 'es'. Module workers are supported by the renderer's Chromium in dev and in
    // the packaged file:// build.
    worker: {
      format: 'es',
    },
    server: {
      port: 5173,
    },
  },
});
