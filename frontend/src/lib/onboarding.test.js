import { describe, expect, it } from 'vitest'
import {
  formatCooldown,
  isCompleteCode,
  normalizeCode,
  routeForAccountStatus,
} from './onboarding'

describe('normalizeCode', () => {
  it('keeps only digits', () => {
    expect(normalizeCode('12-34 56')).toBe('123456')
  })

  it('truncates past six digits', () => {
    expect(normalizeCode('1234567890')).toBe('123456')
  })

  it('survives null and undefined', () => {
    expect(normalizeCode(null)).toBe('')
    expect(normalizeCode(undefined)).toBe('')
  })
})

describe('isCompleteCode', () => {
  it('is true at exactly six digits', () => {
    expect(isCompleteCode('123456')).toBe(true)
    expect(isCompleteCode('12345')).toBe(false)
    expect(isCompleteCode('')).toBe(false)
  })
})

describe('formatCooldown', () => {
  it('renders mm:ss', () => {
    expect(formatCooldown(65)).toBe('1:05')
    expect(formatCooldown(9)).toBe('0:09')
  })

  it('clamps negatives to zero', () => {
    expect(formatCooldown(-5)).toBe('0:00')
  })
})

describe('routeForAccountStatus', () => {
  it('sends unverified accounts to the code screen', () => {
    expect(routeForAccountStatus('pending_verification')).toBe('/signup/verify')
  })

  it('sends every unpaid state to the subscribe screen', () => {
    for (const status of ['pending_payment', 'past_due', 'canceled']) {
      expect(routeForAccountStatus(status)).toBe('/subscription')
    }
  })

  it('lets active accounts through', () => {
    expect(routeForAccountStatus('active')).toBeNull()
  })

  it('lets a superadmin with no account through', () => {
    // A null status is "no account row", not "unpaid" — otherwise the platform owner is
    // redirected to a paywall for a subscription they were never meant to have.
    expect(routeForAccountStatus(null)).toBeNull()
    expect(routeForAccountStatus(undefined)).toBeNull()
  })
})
