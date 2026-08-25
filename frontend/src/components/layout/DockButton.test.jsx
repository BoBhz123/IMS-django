import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DockButton } from './DockButton'

describe('DockButton', () => {
  it('names itself from the label when that is all there is', () => {
    render(<DockButton label="Light mode" onClick={vi.fn()}>x</DockButton>)
    expect(screen.getByRole('button')).toHaveAccessibleName('Light mode')
  })

  it('lets the accessible name differ from the tooltip', () => {
    // The tooltip is read beside a control the user can already see, so it carries the action
    // only. An accessible name has to carry the current state too, since a screen-reader user
    // never sees the glyph. CurrencyToggle is the case that needs this.
    render(
      <DockButton label="Switch to LBP" ariaLabel="Currency: USD. Switch to LBP." onClick={vi.fn()}>
        x
      </DockButton>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName('Currency: USD. Switch to LBP.')
    expect(button).toHaveTextContent('Switch to LBP')
  })

  it('reveals the tooltip on hover and hides it again', async () => {
    const user = userEvent.setup()
    render(<DockButton label="Dark mode" onClick={vi.fn()}>x</DockButton>)

    expect(screen.getByText('Dark mode').className).toMatch(/opacity-0/)
    await user.hover(screen.getByRole('button'))
    expect(screen.getByText('Dark mode').className).toMatch(/opacity-100/)
    await user.unhover(screen.getByRole('button'))
    expect(screen.getByText('Dark mode').className).toMatch(/opacity-0/)
  })

  it('fires its onClick', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<DockButton label="Go" onClick={onClick}>x</DockButton>)

    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not submit a surrounding form', () => {
    // type="button" is load-bearing anywhere this lands inside a form.
    render(<DockButton label="Go" onClick={vi.fn()}>x</DockButton>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })
})
