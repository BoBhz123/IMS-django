import { describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_LENGTH,
  STEPS,
  canSubmitCode,
  canSubmitPassword,
  errorMessage,
  passwordProblem,
} from '@/lib/passwordReset'

describe('STEPS', () => {
  it('runs request then code then password', () => {
    expect(STEPS).toEqual(['request', 'code', 'password'])
  })
})

describe('passwordProblem', () => {
  it('accepts a reasonable password', () => {
    expect(passwordProblem('brandNewPw!2026', 'brandNewPw!2026')).toBeNull()
  })

  it('asks for something when the field is empty', () => {
    expect(passwordProblem('', '')).toBe('Enter a new password.')
  })

  it('enforces the same minimum length as Django', () => {
    expect(passwordProblem('short1!', 'short1!')).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  })

  it('rejects an all-numeric password, as the server would', () => {
    expect(passwordProblem('12345678901', '12345678901')).toBe('Use more than just numbers.')
  })

  it('reports a mismatch last, so the password itself is fixed first', () => {
    // Order matters: telling someone their passwords do not match while the password is also
    // too short sends them re-typing a password that will be refused anyway.
    expect(passwordProblem('short', 'different')).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
    expect(passwordProblem('brandNewPw!2026', 'different')).toBe(
      'The two passwords do not match.',
    )
  })

  it('survives null and undefined', () => {
    expect(passwordProblem(null, undefined)).toBe('Enter a new password.')
  })
})

describe('canSubmitPassword', () => {
  it('is true only when there is no problem', () => {
    expect(canSubmitPassword('brandNewPw!2026', 'brandNewPw!2026')).toBe(true)
    expect(canSubmitPassword('brandNewPw!2026', 'nope')).toBe(false)
  })
})

describe('canSubmitCode', () => {
  it('wants all six digits', () => {
    expect(canSubmitCode('123456')).toBe(true)
    expect(canSubmitCode('12345')).toBe(false)
    expect(canSubmitCode('')).toBe(false)
  })
})

describe('errorMessage', () => {
  it('reads a flow error from detail', () => {
    expect(
      errorMessage({ response: { data: { detail: 'That code is not correct.' } } }),
    ).toBe('That code is not correct.')
  })

  it('reads a field error, which detail alone would render as [object Object]', () => {
    expect(
      errorMessage({
        response: { data: { new_password: ['This password is too common.'] } },
      }),
    ).toBe('This password is too common.')
  })

  it('falls back when the shape is unrecognised', () => {
    expect(errorMessage({ response: { data: { weird: true } } }, 'fallback')).toBe('fallback')
    expect(errorMessage(undefined, 'fallback')).toBe('fallback')
  })
})
