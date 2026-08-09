import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_FORMAT_NAMES,
  describeCameraError,
  isSecureContextForCamera,
  normalizeScan,
  pickCamera,
} from '@/lib/barcode'

describe('SUPPORTED_FORMAT_NAMES', () => {
  it('covers the retail formats the brief requires', () => {
    expect(SUPPORTED_FORMAT_NAMES).toEqual(['EAN_13', 'EAN_8', 'UPC_A', 'CODE_128'])
  })
})

describe('isSecureContextForCamera', () => {
  it('accepts a secure context', () => {
    expect(isSecureContextForCamera({ isSecureContext: true, location: { hostname: 'x' } })).toBe(true)
  })

  it('accepts plain-http localhost, which browsers treat as secure', () => {
    expect(isSecureContextForCamera({ isSecureContext: false, location: { hostname: 'localhost' } })).toBe(true)
  })

  it('rejects a LAN address over http — the phone-testing trap', () => {
    expect(isSecureContextForCamera({ isSecureContext: false, location: { hostname: '192.168.1.20' } })).toBe(false)
  })
})

describe('pickCamera', () => {
  const front = { deviceId: 'a', label: 'FaceTime HD Camera (front)' }
  const back = { deviceId: 'b', label: 'Back Camera' }

  it('prefers a rear camera for scanning', () => {
    expect(pickCamera([front, back], 'back')).toBe(back)
  })

  it('finds the front camera when asked', () => {
    expect(pickCamera([front, back], 'front')).toBe(front)
  })

  it('falls back to the only camera rather than returning nothing', () => {
    expect(pickCamera([front], 'back')).toBe(front)
  })

  it('falls back when labels are empty, as they are before permission is granted', () => {
    const unlabelled = [{ deviceId: 'a', label: '' }, { deviceId: 'b', label: '' }]
    expect(pickCamera(unlabelled, 'back')).toBe(unlabelled[0])
  })

  it('returns null when there are no cameras at all', () => {
    expect(pickCamera([], 'back')).toBeNull()
  })
})

describe('normalizeScan', () => {
  it('strips whitespace a scanner appends', () => {
    expect(normalizeScan('  5901234123457 ')).toBe('5901234123457')
  })

  it('rejects an empty read', () => {
    expect(normalizeScan('   ')).toBeNull()
    expect(normalizeScan(null)).toBeNull()
  })
})

describe('describeCameraError', () => {
  it('explains a denied permission in terms the user can act on', () => {
    expect(describeCameraError({ name: 'NotAllowedError' })).toMatch(/permission/i)
  })

  it('explains a missing camera', () => {
    expect(describeCameraError({ name: 'NotFoundError' })).toMatch(/no camera/i)
  })

  it('has a fallback for anything else', () => {
    expect(describeCameraError({ name: 'Whatever' })).toBeTruthy()
  })
})
