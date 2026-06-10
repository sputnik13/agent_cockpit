import type { RendererApi } from '@shared/ipc/api';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
