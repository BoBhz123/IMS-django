import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyToggle } from './CurrencyToggle'

let context = null
const toggleCurrency = vi.fn()

vi.mock('@/context/CurrencyContext', () => ({
  useCurrency: () => context,
}))

function currencyContext(overrides = {}) {
  return {
    currency: 'USD',
    primaryCurrency: 'USD',
    secondaryCurrency: 'LBP',
    enableDualCurrency: true,
    toggleCurrency,
    ...overrides,
  }
}

const toggle = () => screen.getByRole('button')

beforeEach(() => {
  toggleCurrency.mockReset()
  context = currencyContext()
})

describe('CurrencyToggle', () => {
  it('flips the currency on a single press', async () => {
    const user = userEvent.setup()
    render(<CurrencyToggle />)

    await user.click(toggle())
    expect(toggleCurrency).toHaveBeenCalledTimes(1)
  })

  it('opens no menu — the press is the whole interaction', async () => {
    // This replaced a dropdown. One press, one flip: nothing to open, nothing to dismiss.
    const user = userEvent.setup()
    render(<CurrencyToggle />)

    await user.click(toggle())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('flips again on a second press rather than latching', async () => {
    const user = userEvent.setup()
    render(<CurrencyToggle />)

    await user.click(toggle())
    await user.click(toggle())
    expect(toggleCurrency).toHaveBeenCalledTimes(2)
  })

  it('shows the active currency as a code, not only a symbol', async () => {
    // A bare "$" asks the user to guess whether it means "you are in dollars" or "press for
    // dollars" — opposite readings, with nothing on screen to settle it.
    render(<CurrencyToggle />)
    expect(toggle()).toHaveTextContent('USD')
    expect(toggle()).toHaveTextContent('$')
  })

  it('shows LBP once LBP is the active currency', () => {
    context = currencyContext({ currency: 'LBP' })
    render(<CurrencyToggle />)
    expect(toggle()).toHaveTextContent('LBP')
    expect(toggle()).toHaveTextContent('ل.ل')
  })

  it('announces the current state and what pressing it will do', () => {
    render(<CurrencyToggle />)
    // Both halves. The visible code cannot carry the outcome, and a label that carries only
    // the outcome reads as the current mode to anyone who never sees the glyph.
    expect(toggle()).toHaveAccessibleName('Currency: US Dollar. Switch to Lebanese Pound.')
  })

  it('describes the swap the right way round for an LBP-based account', () => {
    // Derived from the account's own pair rather than assuming USD is always the base.
    context = currencyContext({
      currency: 'LBP', primaryCurrency: 'LBP', secondaryCurrency: 'USD',
    })
    render(<CurrencyToggle />)
    expect(toggle()).toHaveAccessibleName('Currency: Lebanese Pound. Switch to US Dollar.')
  })

  it('renders nothing at all when dual display is off', () => {
    // Not merely disabled: the account is strictly single-currency, so a switch would offer
    // something that does not exist.
    context = currencyContext({ enableDualCurrency: false })
    const { container } = render(<CurrencyToggle />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps a hover affordance in both placements', () => {
    const { unmount } = render(<CurrencyToggle placement="right" />)
    expect(toggle().className).toMatch(/hover:bg-canvas-2/)
    unmount()

    render(<CurrencyToggle placement="bottom" />)
    expect(toggle().className).toMatch(/hover:bg-canvas-2/)
  })

  it('meets the touch target size in the mobile header', () => {
    // The header variant is the one a thumb hits.
    render(<CurrencyToggle placement="bottom" />)
    expect(toggle().className).toMatch(/touch-target/)
  })

  describe('in the dock rail', () => {
    it('wears the rail chrome, so it matches the buttons beside it', () => {
      // Rendered through DockButton rather than reimplementing its 40px squircle. A control
      // that is visibly a dock button but silently not one is the difference nobody reports
      // and everybody notices.
      render(<CurrencyToggle placement="right" />)
      expect(toggle().className).toMatch(/h-10 w-10/)
      expect(toggle().className).toMatch(/rounded-2xl/)
    })

    it('carries the hover tooltip the rest of the rail has', async () => {
      const user = userEvent.setup()
      render(<CurrencyToggle placement="right" />)

      // Always in the DOM — DockButton animates opacity rather than mounting on hover.
      expect(toggle()).toHaveTextContent('Switch to Lebanese Pound')

      await user.hover(toggle())
      const tooltip = screen.getByText('Switch to Lebanese Pound')
      expect(tooltip.className).toMatch(/opacity-100/)

      await user.unhover(toggle())
      expect(screen.getByText('Switch to Lebanese Pound').className).toMatch(/opacity-0/)
    })

    it('tells the tooltip the action and the accessible name the state too', () => {
      // A tooltip sits beside a control the user can already see, so the action alone is
      // right. A screen-reader user never sees the glyph and needs both.
      render(<CurrencyToggle placement="right" />)
      expect(toggle()).toHaveAccessibleName('Currency: US Dollar. Switch to Lebanese Pound.')
      expect(toggle()).toHaveTextContent('Switch to Lebanese Pound')
    })

    it('still flips on a press', async () => {
      const user = userEvent.setup()
      render(<CurrencyToggle placement="right" />)
      await user.click(toggle())
      expect(toggleCurrency).toHaveBeenCalledTimes(1)
    })
  })
})
