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
    // ⚠️ DEV ONLY — REVERT BEFORE DEPLOY. See the pre-deploy note in CLAUDE.md.
    //
    // Vite rejects requests whose Host header it doesn't recognise (DNS-rebinding protection),
    // which makes every tunnel URL return "Blocked request". Tunnels are how the camera barcode
    // scanner gets tested at all: getUserMedia needs a secure context, so a phone on the LAN
    // hitting http://192.168.x.x:5173 has no camera — it needs the tunnel's HTTPS origin.
    //
    // Scoped to the two tunnel providers rather than `true`, which disables the check outright.
    // A leading dot matches subdomains. If you switch providers (ngrok etc.), add its suffix
    // here rather than widening this to `true`.
    allowedHosts: ['.trycloudflare.com', '.loca.lt'],
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
