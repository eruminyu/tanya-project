/// <reference types="vite/client" />

import type { DesktopBridge } from './shared/bridge.js';

declare global {
  interface Window {
    readonly kirianDesktop?: DesktopBridge;
  }
}

export {};
