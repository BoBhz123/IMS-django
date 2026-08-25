import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDailyTick } from '@/hooks/useDailyTick'
import { usePageVisible } from '@/hooks/usePageVisible'

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function Probe() {
  const now = useDailyTick()
  return <span data-testid="now">{now}</span>
}

function VisibilityProbe() {
  const visible = usePageVisible()
  return <span data-testid="visible">{String(visible)}</span>
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  delete document.visibilityState
})

describe('useDailyTick', () => {
  it('does not retick every second', () => {
    // The point of the hook. A per-second interval on a component mounted in the app shell
    // re-renders everything below it once a second to produce the same string.
    vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
    render(<Probe />)
    const initial = screen.getByTestId('now').textContent

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('now').textContent).toBe(initial)
  })

  it('reticks when the date rolls over', () => {
    vi.setSystemTime(new Date(2026, 7, 25, 23, 59, 0))
    render(<Probe />)
    const initial = Number(screen.getByTestId('now').textContent)

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000)
    })
    expect(Number(screen.getByTestId('now').textContent)).toBeGreaterThan(initial)
  })

  it('reticks when the tab comes back', () => {
    // The correctness half, not an optimisation. A background tab has its timers throttled
    // and a sleeping machine does not fire them at all, so a laptop closed on Tuesday and
    // opened on Friday would still be showing Tuesday's count without this.
    vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
    render(<Probe />)
    const initial = Number(screen.getByTestId('now').textContent)

    setVisibility('hidden')
    vi.setSystemTime(new Date(2026, 7, 28, 10, 0, 0))
    setVisibility('visible')

    expect(Number(screen.getByTestId('now').textContent)).toBeGreaterThan(initial)
  })

  it('clears its timer and listener on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = render(<Probe />)
    unmount()

    expect(clearSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    clearSpy.mockRestore()
    removeSpy.mockRestore()
  })
})

describe('usePageVisible', () => {
  it('tracks the document', () => {
    setVisibility('visible')
    render(<VisibilityProbe />)
    expect(screen.getByTestId('visible')).toHaveTextContent('true')

    setVisibility('hidden')
    expect(screen.getByTestId('visible')).toHaveTextContent('false')
  })

  it('detaches on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<VisibilityProbe />)
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    removeSpy.mockRestore()
  })
})
