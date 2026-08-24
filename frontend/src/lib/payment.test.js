import { describe, expect, it } from 'vitest'
import {
  PAYMENT_STATUS,
  paidFor,
  partialAmountMissing,
  paymentPayload,
  remainingFor,
} from './payment'

const { PAID, PARTIALLY_PAID, UNPAID } = PAYMENT_STATUS

describe('paidFor', () => {
  it('settles the whole total when fully paid, ignoring any amount left in the field', () => {
    // The amount input is hidden but not cleared when the user switches back to Fully paid, so
    // a stale value must not survive into the calculation.
    expect(paidFor(120, PAID, 40)).toBe(120)
  })

  it('settles nothing when unpaid', () => {
    expect(paidFor(120, UNPAID, 40)).toBe(0)
  })

  it('settles the entered amount when partially paid', () => {
    expect(paidFor(120, PARTIALLY_PAID, 40)).toBe(40)
  })

  it('reads a string amount, which is what a text input gives back', () => {
    expect(paidFor(120, PARTIALLY_PAID, '40.50')).toBe(40.5)
  })

  it('treats an unparseable amount as nothing paid', () => {
    expect(paidFor(120, PARTIALLY_PAID, '')).toBe(0)
    expect(paidFor(120, PARTIALLY_PAID, 'abc')).toBe(0)
  })
})

describe('remainingFor', () => {
  it('owes nothing when fully paid', () => {
    expect(remainingFor(120, PAID, 0)).toBe(0)
  })

  it('owes the whole total when unpaid', () => {
    expect(remainingFor(120, UNPAID, 0)).toBe(120)
  })

  it('owes the balance when partially paid', () => {
    expect(remainingFor(120, PARTIALLY_PAID, 72)).toBe(48)
  })

  it('clamps an overpayment to zero rather than reporting a refund', () => {
    // Rounding a cash settlement up is routine here. A negative remainder would print on the
    // invoice as money the business owes back, which it does not.
    expect(remainingFor(120, PARTIALLY_PAID, 130)).toBe(0)
  })

  it('owes nothing on a zero total', () => {
    expect(remainingFor(0, UNPAID, 0)).toBe(0)
  })
})

describe('partialAmountMissing', () => {
  it('is false for the two states that need no amount', () => {
    expect(partialAmountMissing(PAID, '')).toBe(false)
    expect(partialAmountMissing(UNPAID, '')).toBe(false)
  })

  it('is true when a partial payment has no amount', () => {
    expect(partialAmountMissing(PARTIALLY_PAID, '')).toBe(true)
    expect(partialAmountMissing(PARTIALLY_PAID, null)).toBe(true)
    expect(partialAmountMissing(PARTIALLY_PAID, undefined)).toBe(true)
  })

  it('is true for a zero or negative partial amount', () => {
    // Zero is "unpaid" and negative is meaningless; both have a state of their own to sit in.
    expect(partialAmountMissing(PARTIALLY_PAID, 0)).toBe(true)
    expect(partialAmountMissing(PARTIALLY_PAID, -5)).toBe(true)
  })

  it('is false for a real partial amount', () => {
    expect(partialAmountMissing(PARTIALLY_PAID, 40)).toBe(false)
  })
})

describe('paymentPayload', () => {
  it('sends the status alone when fully paid', () => {
    // No paid_amount: the server settles it against the total it computed from the line rows it
    // just wrote, so a stale browser-side total can never overwrite the real one.
    expect(paymentPayload(PAID, 40)).toEqual({ payment_status: 'PAID' })
  })

  it('sends the status alone when unpaid', () => {
    expect(paymentPayload(UNPAID, 40)).toEqual({ payment_status: 'UNPAID' })
  })

  it('sends the amount alongside the status when partially paid', () => {
    // The server refuses PARTIALLY_PAID without an amount rather than guessing one.
    expect(paymentPayload(PARTIALLY_PAID, '40.50')).toEqual({
      payment_status: 'PARTIALLY_PAID',
      paid_amount: 40.5,
    })
  })
})
