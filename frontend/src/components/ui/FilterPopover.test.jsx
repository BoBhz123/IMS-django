import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetOverlayStack } from '@/lib/overlayStack'
import { FilterPopover } from './FilterPopover'

/**
 * The panel is wrapped in AnimatePresence, so it stays mounted through its exit animation. A
 * bare `expect(...).not.toBeInTheDocument()` immediately after a click asserts against the
 * frame before the animation finishes and fails on a popover that is closing correctly.
 */
const expectClosed = () =>
  waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

describe('FilterPopover', () => {
  beforeEach(() => {
    resetOverlayStack()
  })

  it('keeps the filters hidden until the trigger is pressed', () => {
    render(
      <FilterPopover>
        <input aria-label="Search" />
      </FilterPopover>,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the panel on the trigger', async () => {
    const user = userEvent.setup()
    render(
      <FilterPopover>
        <input aria-label="Search" />
      </FilterPopover>,
    )

    await user.click(screen.getByRole('button', { name: /show filters/i }))

    expect(await screen.findByRole('dialog', { name: /filters/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toBeInTheDocument()
  })

  it('closes again when the trigger is pressed a second time', async () => {
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)

    const trigger = screen.getByRole('button', { name: /show filters/i })
    await user.click(trigger)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.click(trigger)
    await expectClosed()
  })

  it('shows how many filters are active', () => {
    // The count is what tells a user their empty result set is a filter, not missing data.
    render(<FilterPopover activeCount={3}><input aria-label="Search" /></FilterPopover>)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('announces the count rather than running it into the label', () => {
    // The default name computation concatenates with no separator — "Show filters3".
    render(<FilterPopover activeCount={3}><input aria-label="Search" /></FilterPopover>)
    expect(screen.getByRole('button', { name: 'Show filters (3 active)' })).toBeInTheDocument()
  })

  it('hides the count badge when nothing is filtered', () => {
    render(<FilterPopover activeCount={0}><input aria-label="Search" /></FilterPopover>)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('floats above the page and stays inside the viewport', async () => {
    // The panel used to be clipped by an overflow-hidden ancestor in AppShell; these are the
    // panel's own half of that fix. jsdom does no layout, so this asserts the contract the
    // stylesheet expresses rather than a measured position — see AppShell.test.jsx.
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    const panel = await screen.findByRole('dialog')
    expect(panel.className).toMatch(/\bz-50\b/)
    // Without the viewport cap, 20rem plus the shell's padding overflows a narrow phone.
    expect(panel.className).toMatch(/max-w-\[calc\(100vw-2rem\)\]/)
  })

  it('anchors to the left of the trigger by default', async () => {
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    // The trigger is the leftmost thing in every page header, so right-anchoring would hang
    // the panel off the left edge of the screen.
    const panel = await screen.findByRole('dialog')
    expect(panel.className).toMatch(/\bleft-0\b/)
    expect(panel.className).not.toMatch(/\bright-0\b/)
  })

  it('can anchor to the right for a trigger near the right edge', async () => {
    const user = userEvent.setup()
    render(<FilterPopover align="right"><input aria-label="Search" /></FilterPopover>)
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    const panel = await screen.findByRole('dialog')
    expect(panel.className).toMatch(/\bright-0\b/)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await expectClosed()
  })

  it('leaves Escape alone when an overlay is stacked above it', async () => {
    // The load-bearing half. A popover that closed on every Escape would also be closing while
    // the user was dismissing a modal on top of it — and the same unconditional listener on the
    // pages underneath is what used to discard a half-entered order.
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    // Something else opens on top, exactly as Modal/SlideOver would.
    const { pushOverlay } = await import('@/lib/overlayStack')
    pushOverlay(Symbol('modal-above'))

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes when the user clicks away', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <FilterPopover><input aria-label="Search" /></FilterPopover>
        <button type="button">Elsewhere</button>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /elsewhere/i }))
    await expectClosed()
  })

  it('stays open while the user interacts with a filter inside it', async () => {
    // A pointerdown handler that did not exclude its own subtree would close the panel the
    // instant the user reached for a select.
    const user = userEvent.setup()
    render(<FilterPopover><input aria-label="Search" /></FilterPopover>)

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    await user.click(await screen.findByLabelText('Search'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('offers Clear all only when something is filtered', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    const { rerender } = render(
      <FilterPopover activeCount={0} onClear={onClear}>
        <input aria-label="Search" />
      </FilterPopover>,
    )

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument()

    rerender(
      <FilterPopover activeCount={2} onClear={onClear}>
        <input aria-label="Search" />
      </FilterPopover>,
    )
    await user.click(screen.getByRole('button', { name: /clear all/i }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
