// Kept free of React and of @zxing/library itself, so every branch here is testable without a
// camera — which matters because this project forbids browser automation for verification.

export const SUPPORTED_FORMAT_NAMES = ['EAN_13', 'EAN_8', 'UPC_A', 'CODE_128']

/**
 * getUserMedia is unavailable outside a secure context. Browsers make one exception:
 * localhost over plain http. Opening the Vite dev server from a phone on the LAN
 * (http://192.168.x.x:5173) is therefore silently camera-less, which reads as a broken
 * feature rather than a platform rule — hence the explicit check and message.
 */
export function isSecureContextForCamera(win = window) {
  if (win.isSecureContext) return true
  return ['localhost', '127.0.0.1', '::1'].includes(win.location?.hostname)
}

const BACK_HINTS = ['back', 'rear', 'environment']
const FRONT_HINTS = ['front', 'user', 'face']

export function pickCamera(devices, facing = 'back') {
  if (!devices?.length) return null
  const hints = facing === 'front' ? FRONT_HINTS : BACK_HINTS
  const match = devices.find((device) =>
    hints.some((hint) => (device.label ?? '').toLowerCase().includes(hint)),
  )
  // Labels are empty strings until camera permission has been granted, and a laptop has one
  // camera with no hint in its name. Falling back to the first device beats refusing to scan.
  return match ?? devices[0]
}

export function normalizeScan(text) {
  const trimmed = (text ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.'
    case 'NotReadableError':
      return 'The camera is already in use by another app.'
    default:
      return "The camera couldn't be started. You can type the barcode instead."
  }
}
