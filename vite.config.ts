/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Tauri expects a fixed port and no clearing of its console output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 (Chromium) on Windows, WebKit on macOS.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome120' : 'safari16',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: { environment: 'jsdom' },
});
