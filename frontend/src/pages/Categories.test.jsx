import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Categories } from '@/pages/Categories'

const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()
const del = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args) => get(...args),
    post: (...args) => post(...args),
    patch: (...args) => patch(...args),
    delete: (...args) => del(...args),
  },
}))

// The categories endpoint is not paginated — it returns a bare array, unlike products/orders.
const ROWS = [
  { id: 1, name: 'Drinks', product_count: 2 },
  { id: 2, name: 'Empty Shelf', product_count: 0 },
]

/**
 * The page renders the same rows twice — a table for `sm:` and up, cards below it — and CSS
 * does not run in jsdom, so both are present. Query inside the table to keep matches unique.
 */
const table = () => within(screen.getByRole('table'))

const waitForRows = () => screen.findByRole('table')

/**
 * The page's "Add category" button and the form's submit button share a label, so match on the
 * button type rather than inventing a different word for one of them.
 */
const submitButton = (name) =>
  screen.getAllByRole('button', { name }).find((button) => button.type === 'submit')

describe('Categories', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    patch.mockReset()
    del.mockReset()
    get.mockResolvedValue({ data: ROWS })
  })

  it('lists categories with how many products each holds', async () => {
    render(<Categories />)
    await waitForRows()

    expect(table().getByText('Drinks')).toBeInTheDocument()
    expect(table().getByText('2 products')).toBeInTheDocument()
    expect(table().getByText('0 products')).toBeInTheDocument()
  })

  it('creates a category', async () => {
    const user = userEvent.setup()
    post.mockResolvedValue({ data: { id: 3, name: 'Snacks', product_count: 0 } })
    render(<Categories />)
    await waitForRows()

    await user.click(screen.getByRole('button', { name: /add category/i }))
    await user.type(await screen.findByRole('textbox', { name: /name/i }), 'Snacks')
    await user.click(submitButton(/^add category$/i))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/inventory/categories/', { name: 'Snacks' }),
    )
  })

  it('shows the server message when a name is already taken', async () => {
    const user = userEvent.setup()
    post.mockRejectedValue({
      response: { status: 400, data: { name: ['You already have a category with this name.'] } },
    })
    render(<Categories />)
    await waitForRows()

    await user.click(screen.getByRole('button', { name: /add category/i }))
    await user.type(await screen.findByRole('textbox', { name: /name/i }), 'Drinks')
    await user.click(submitButton(/^add category$/i))

    expect(await screen.findByText(/already have a category with this name/i)).toBeInTheDocument()
  })

  it('renames a category', async () => {
    const user = userEvent.setup()
    patch.mockResolvedValue({ data: {} })
    render(<Categories />)
    await waitForRows()

    await user.click(table().getAllByRole('button', { name: /edit/i })[0])
    const field = await screen.findByRole('textbox', { name: /name/i })
    await user.clear(field)
    await user.type(field, 'Beverages')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/inventory/categories/1/', { name: 'Beverages' }),
    )
  })

  it('will not offer to delete a category that still holds products', async () => {
    render(<Categories />)
    await waitForRows()

    // Disabled rather than hidden, so the reason is visible instead of the feature looking absent.
    expect(table().getByRole('button', { name: /delete Drinks/i })).toBeDisabled()
    expect(table().getByRole('button', { name: /delete Empty Shelf/i })).toBeEnabled()
  })

  it('deletes an empty category', async () => {
    const user = userEvent.setup()
    del.mockResolvedValue({})
    render(<Categories />)
    await waitForRows()

    await user.click(table().getByRole('button', { name: /delete Empty Shelf/i }))
    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(del).toHaveBeenCalledWith('/inventory/categories/2/'))
  })

  it("surfaces the server's reason when a delete is refused", async () => {
    const user = userEvent.setup()
    del.mockRejectedValue({
      response: {
        status: 409,
        data: { detail: 'This category still has products in it. Move those products first.' },
      },
    })
    render(<Categories />)
    await waitForRows()

    await user.click(table().getByRole('button', { name: /delete Empty Shelf/i }))
    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    // The generic "may still be referenced" fallback would not tell the user what to do.
    expect(await screen.findByText(/still has products in it/i)).toBeInTheDocument()
  })

  it('searches by name', async () => {
    const user = userEvent.setup()
    render(<Categories />)
    await waitForRows()

    await user.type(screen.getByPlaceholderText(/search categories/i), 'dri')

    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith('/inventory/categories/', {
        params: { ordering: 'name', search: 'dri' },
      }),
    )
  })

  it('invites a first category when there are none', async () => {
    get.mockResolvedValue({ data: [] })
    render(<Categories />)

    expect(await screen.findByText(/no categories yet/i)).toBeInTheDocument()
  })
})
