// Tiny pub/sub so non-React code (the axios interceptor) can raise toasts without
// needing a React context — ToastContainer is the only subscriber, mounted once in AppShell.
const listeners = new Set()
let idCounter = 0

export function subscribeToasts(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(type, message) {
  if (!message) return
  listeners.forEach((listener) => listener({ id: ++idCounter, type, message }))
}

export const toast = {
  error: (message) => emit('error', message),
  success: (message) => emit('success', message),
}
