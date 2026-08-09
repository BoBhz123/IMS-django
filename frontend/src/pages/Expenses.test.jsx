import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Expenses } from '@/pages/Expenses'

const get = vi.fn()
const del = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args) => get(...args),
    delete: (...args) => del(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))
vi.mock('@/context/CurrencyContext', () => ({
  useCurrency: () => ({ formatAmount: (value) => `$${Number(value).toFixed(2)}` }),
}))

const PAGE = {
  count: 2,
  results: [
    {
      id: 1, description: 'Shop rent', amount: '500.00',
      category: 'rent', category_display: 'Rent', spent_at: '2026-03-01T12:00:00Z',
    },
    {
      id: 2, description: 'Instagram ads', amount: '75.50',
      category: 'marketing', category_display: 'Marketing', spent_at: '2026-03-04T12:00:00Z',
    },
  ],
}

describe('Expenses', () => {
  beforeEach(() => {
    get.mockReset()
    del.mockReset()
    get.mockResolvedValue({ data: PAGE })
  })

  it('lists expenses with their category and amount', async () => {
    render(<Expenses />)
    expect(await screen.findByText('Shop rent')).toBeInTheDocument()
    expect(screen.getByText('Instagram ads')).toBeInTheDocument()
    expect(screen.getAllByText('Rent').length).toBeGreaterThan(0)
    expect(screen.getByText('$500.00')).toBeInTheDocument()
  })

  it('shows the running total for the current filter', async () => {
    render(<Expenses />)
    expect(await screen.findByText(/575\.50/)).toBeInTheDocument()
  })

  it('filters by category', async () => {
    render(<Expenses />)
    await screen.findByText('Shop rent')
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'marketing')

    await waitFor(() => {
      const lastCall = get.mock.calls[get.mock.calls.length - 1]
      expect(lastCall[1].params.category).toBe('marketing')
    })
  })

  it('asks before deleting', async () => {
    render(<Expenses />)
    await screen.findByText('Shop rent')
    await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    expect(await screen.findByText(/permanently removed/i)).toBeInTheDocument()
    expect(del).not.toHaveBeenCalled()
  })

  it('shows an empty state when there is nothing to show', async () => {
    get.mockResolvedValue({ data: { count: 0, results: [] } })
    render(<Expenses />)
    expect(await screen.findByText(/no expenses/i)).toBeInTheDocument()
  })

  it('reports a failed load instead of rendering an empty table', async () => {
    get.mockRejectedValue(new Error('boom'))
    render(<Expenses />)
    expect(await screen.findByText(/couldn't load expenses/i)).toBeInTheDocument()
  })
})
