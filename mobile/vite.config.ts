/// <reference types="vitest" />

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react()
  ],
  // No @vitejs/plugin-legacy: it emitted a second full nomodule copy of every chunk (11 MB dist).
  // The Android System WebView auto-updates from Play, so a modern target is safe on minSdk 24 devices.
  build: { target: 'chrome87' },
  worker: {
    format: 'es',
  },
  server: {
    host: true
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  }
})
