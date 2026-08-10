import { describe, expect, it } from 'vitest'
import { formatKeyInput, isCompleteKey, normalizeKey } from '@/lib/billing'

describe('normalizeKey', () => {
  it('uppercases and strips dashes and spaces', () => {
    expect(normalizeKey('abcd-efgh jkmn')).toBe('ABCDEFGHJKMN')
  })

  it('drops characters outside the alphabet', () => {
    // 0, O, 1, I and L are not in the alphabet — a user reading a key aloud will
    // substitute them, and silently keeping them guarantees a failed redemption.
    expect(normalizeKey('ABCD0OIL2345')).toBe('ABCD2345')
  })

  it('truncates past the key length', () => {
    expect(normalizeKey('ABCDEFGHJKMNPQRS')).toBe('ABCDEFGHJKMN')
  })

  it('survives null', () => {
    expect(normalizeKey(null)).toBe('')
  })
})

describe('isCompleteKey', () => {
  it('is true at exactly twelve characters', () => {
    expect(isCompleteKey('ABCD-EFGH-JKMN')).toBe(true)
    expect(isCompleteKey('ABCDEFGHJKM')).toBe(false)
  })
})

describe('formatKeyInput', () => {
  it('groups in fours as the user types', () => {
    expect(formatKeyInput('ABCDEFGH')).toBe('ABCD-EFGH')
  })

  it('does not leave a trailing dash', () => {
    expect(formatKeyInput('ABCD')).toBe('ABCD')
  })

  it('is empty for empty input', () => {
    expect(formatKeyInput('')).toBe('')
  })
})
