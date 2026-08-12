import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { CurrencyInput } from './CurrencyInput'

/** Mirrors how the order/purchase forms use it: parent owns the USD value. */
function Harness({ initial = 0, onChange = () => {} }) {
  const [value, setValue] = useState(initial)
  return (
    <CurrencyProvider>
      <CurrencyInput
        valueUsd={value}
        onChangeUsd={(v) => {
          setValue(v)
          onChange(v)
        }}
      />
      <button type="button" onClick={() => setValue(6)}>
        Fill from product
      </button>
    </CurrencyProvider>
  )
}

const field = () => screen.getByRole('textbox')

describe('CurrencyInput', () => {
  it('shows a value the parent sets after mount', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    // This is what picking or scanning a product does to an order line. Before this synced,
    // the field read 0 while the order total read the real price.
    await user.click(screen.getByRole('button', { name: /fill from product/i }))

    expect(field()).toHaveValue('6')
  })

  it('leaves a part-typed decimal alone', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.clear(field())
    await user.type(field(), '6.')

    // "6." parses to 6, which is what the parent now holds — rewriting it to "6" would delete
    // the point the user just typed.
    expect(field()).toHaveValue('6.')
  })

  it('keeps trailing zeros while typing', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.clear(field())
    await user.type(field(), '6.50')

    expect(field()).toHaveValue('6.50')
  })

  it('does not refill a field the user has emptied', async () => {
    const user = userEvent.setup()
    render(<Harness initial={12} />)

    await user.clear(field())

    // Clearing reports 0 to the parent; snapping the text back to "0" would make the field
    // impossible to empty.
    expect(field()).toHaveValue('')
  })

  it('reports what the user types in USD', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness onChange={onChange} />)

    await user.clear(field())
    await user.type(field(), '7.25')

    expect(onChange).toHaveBeenLastCalledWith(7.25)
  })
})
