import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'
import { resetOverlayStack } from '@/lib/overlayStack'

function Layer({ open, lockScroll }) {
  useOverlayLayer(open, lockScroll === undefined ? undefined : { lockScroll })
  return <div data-testid="layer" />
}

beforeEach(() => {
  resetOverlayStack()
  document.body.style.overflow = ''
})

describe('useOverlayLayer scroll locking', () => {
  it('locks the page by default, for modes that cover it', () => {
    render(<Layer open />)
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('releases the lock when the overlay closes', () => {
    const { rerender } = render(<Layer open />)
    expect(document.body.style.overflow).toBe('hidden')

    rerender(<Layer open={false} />)
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('does not lock when the layer opts out', () => {
    // The bug this option exists for: a popover is anchored to something on the page and dims
    // nothing, so locking the body freezes the very table the user opened it to filter.
    // FilterPopover's own doc comment said it must not lock scrolling — and it did.
    render(<Layer open lockScroll={false} />)
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('keeps the page locked while a modal is open under a popover', () => {
    // The asymmetry that would break the refcount. A non-locking layer must not *release* on
    // unmount either, or closing a popover opened over a modal hands scrolling back while the
    // modal is still covering the page.
    const { unmount: closeModal } = render(<Layer open />)
    expect(document.body.style.overflow).toBe('hidden')

    const { unmount: closePopover } = render(<Layer open lockScroll={false} />)
    expect(document.body.style.overflow).toBe('hidden')

    closePopover()
    expect(document.body.style.overflow).toBe('hidden')

    closeModal()
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('still stacks a non-locking layer for Escape ordering', () => {
    // Opting out of the lock must not opt out of the stack — that is the half that stops a
    // popover's Escape closing the slide-over behind it.
    const reports = []
    function Reporting({ open, lockScroll, name }) {
      const { isTop } = useOverlayLayer(open, { lockScroll })
      reports.push([name, isTop])
      return null
    }

    render(<Reporting open lockScroll={false} name="popover" />)
    const [, popoverIsTop] = reports.at(-1)
    expect(popoverIsTop()).toBe(true)

    const modal = render(<Reporting open lockScroll name="modal" />)
    const [, modalIsTop] = reports.at(-1)
    expect(modalIsTop()).toBe(true)
    // The popover is registered, just no longer on top — so its Escape handler stands down.
    expect(popoverIsTop()).toBe(false)

    modal.unmount()
    expect(popoverIsTop()).toBe(true)
  })
})
