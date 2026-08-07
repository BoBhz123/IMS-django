import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
  // Component tests render into jsdom; the pure-logic tests under src/lib don't need it but are
  // unaffected by it. `globals` keeps expect/describe/it available without importing them in
  // every file, which is what @testing-library/jest-dom's matchers expect.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
  },
})
