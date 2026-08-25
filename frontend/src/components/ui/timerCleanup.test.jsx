import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportButton } from './ExportButton'
import { ToastContainer } from './ToastContainer'
import { toast } from '@/lib/toast'

/**
 * Timers that outlive the component that scheduled them.
 *
 * Each of these fired a setState into an unmounted tree. React 19 dropped the warning that
 * used to make this visible, so the only evidence was a slow accumulation of scheduled work —
 * and, in the test suite, timers from one file firing during the next.
 */

const AUTO_DISMISS_MS = 5000

const download = vi.fn()
vi.mock('@/lib/download', () => ({ downloadFile: (...args) => download(...args) }))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  download.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ExportButton', () => {
  it('cancels its revert timer when unmounted mid-error', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    download.mockRejectedValue(new Error('nope'))

    const { unmount } = render(<ExportButton url="/x/" filename="x.csv" />)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText(/export failed/i)).toBeInTheDocument()

    const pending = vi.getTimerCount()
    unmount()
    // The timer was scheduled by the click handler, not by an effect, so unmounting is the
    // only thing that can cancel it. Measured as a drop rather than an absolute zero:
    // framer-motion keeps timers of its own alive in this tree.
    expect(vi.getTimerCount()).toBeLessThan(pending)
  })

  it('reverts to idle when it stays mounted', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    download.mockRejectedValue(new Error('nope'))

    render(<ExportButton url="/x/" filename="x.csv" />)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText(/export failed/i)).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText(/export csv/i)).toBeInTheDocument()
  })
})

describe('ToastContainer', () => {
  it('clears every pending auto-dismiss on unmount', () => {
    const { unmount } = render(<ToastContainer />)
    const baseline = vi.getTimerCount()

    act(() => {
      toast.error('one')
      toast.error('two')
      toast.error('three')
    })
    const withToasts = vi.getTimerCount()
    expect(withToasts).toBeGreaterThanOrEqual(baseline + 3)

    unmount()
    // Unsubscribing stopped new toasts arriving but left these three scheduled, each holding
    // the unmounted component's setState for five seconds. All three must go — asserted as a
    // drop of three rather than a return to zero, because framer-motion schedules its own
    // timers in this tree and they are not what this test is about.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(withToasts - 3)
  })

  it('still fires its auto-dismiss while mounted', () => {
    render(<ToastContainer />)
    const baseline = vi.getTimerCount()
    act(() => toast.error('gone in five'))
    expect(screen.getByText('gone in five')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBeGreaterThan(baseline)

    act(() => vi.advanceTimersByTime(AUTO_DISMISS_MS))

    // The timer having fired is the assertion, not the node having left the DOM.
    // AnimatePresence holds it through an exit animation driven by animation frames, and
    // jsdom advances none — asserting on its absence here would be asserting on framer-motion,
    // and would fail against a perfectly working dismiss. What this pins is the half that is
    // ours: the callback was scheduled, survived to its deadline, and ran.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline)
  })
})
