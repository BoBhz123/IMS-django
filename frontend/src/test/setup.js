import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Node 22+ ships an experimental `localStorage` global that resolves to undefined unless
// node is started with --localstorage-file, and it shadows the one jsdom would install.
// App code reads the bare global (CurrencyContext, ThemeContext, lib/api tokenStore), so
// install a plain in-memory implementation rather than depending on either of them.
function createMemoryStorage() {
  let store = new Map()
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
}

for (const target of [globalThis, globalThis.window].filter(Boolean)) {
  Object.defineProperty(target, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  })
}

afterEach(cleanup)
