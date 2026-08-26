import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publicApi } from '@/lib/api'
import { PublicInvoice } from './PublicInvoice'

const PAYLOAD = {
  reference: 'C7BD9F4A',
  placed_at: '2026-08-04T10:00:00Z',
  exchange_rate: '89000.00',
  seller_name: 'Beirut Hardware',
  seller_phone: '+961 70 123 456',
  customer_name: 'Layal',
  customer_phone: '+961 71 999 888',
  customer_location: 'Hamra, Beirut',
  items: [
    { product: 'Widget', quantity: 36, unit_price: '2.50', line_total: '90.00' },
    { product: 'Gadget', quantity: 1, unit_price: '8.00', line_total: '8.00' },
  ],
  total_price: '98.00',
  payment_status: 'PAID',
  paid_amount: '98.00',
  remaining_amount: '0.00',
  primary_currency: 'USD',
  dual_currency: true,
}

function renderAt(token = 'tok3n') {
  return render(
    <MemoryRouter initialEntries={[`/i/${token}`]}>
      <Routes>
        <Route path="/i/:token" element={<PublicInvoice />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** A rejected axios call, shaped the way the interceptor-free client surfaces one. */
function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { detail: 'Not found.' } },
  })
}

let get

beforeEach(() => {
  get = vi.spyOn(publicApi, 'get')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PublicInvoice loading', () => {
  it('shows a loading state while the invoice is in flight', async () => {
    get.mockReturnValue(new Promise(() => {})) // never settles
    renderAt()

    expect(screen.getByRole('status')).toHaveTextContent(/loading invoice/i)
    expect(screen.queryByText('Beirut Hardware')).not.toBeInTheDocument()
  })

  it('reads the token out of the URL and asks for that invoice', async () => {
    get.mockResolvedValue({ data: PAYLOAD })
    renderAt('AbC-123_xyz')

    await screen.findByText('Beirut Hardware')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('/inventory/public/invoice/AbC-123_xyz/')
  })

  it('goes through the interceptor-free client, not the authenticated one', async () => {
    // The server sets authentication_classes = [] so the response depends on the token and
    // nothing else. `api` would attach whatever JWT happens to be in localStorage, toast a
    // dead link, and redirect a lapsed subscription to /subscription — all wrong for a
    // customer who has no session at all.
    const { api } = await import('@/lib/api')
    const authed = vi.spyOn(api, 'get')
    get.mockResolvedValue({ data: PAYLOAD })

    renderAt()
    await screen.findByText('Beirut Hardware')
    expect(authed).not.toHaveBeenCalled()
  })
})

describe('PublicInvoice document', () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: PAYLOAD })
  })

  it('renders the seller, the reference and the issue date', async () => {
    renderAt()
    expect(await screen.findByText('Beirut Hardware')).toBeInTheDocument()
    expect(screen.getByText('+961 70 123 456')).toBeInTheDocument()
    expect(screen.getByText('#C7BD9F4A')).toBeInTheDocument()
    expect(screen.getByText('Aug 4, 2026')).toBeInTheDocument()
  })

  it('renders the customer block', async () => {
    renderAt()
    expect(await screen.findByText(/bill to/i)).toBeInTheDocument()
    expect(screen.getByText('Layal')).toBeInTheDocument()
    expect(screen.getByText('Hamra, Beirut')).toBeInTheDocument()
    expect(screen.getByText('+961 71 999 888')).toBeInTheDocument()
  })

  it('names a walk-in rather than printing an empty line', async () => {
    get.mockResolvedValue({
      data: { ...PAYLOAD, customer_name: null, customer_phone: null, customer_location: null },
    })
    renderAt()
    expect(await screen.findByText(/walk-in customer/i)).toBeInTheDocument()
  })

  it('itemises the lines with quantity, unit price and line total', async () => {
    renderAt()
    await screen.findByText('Widget')

    const row = screen.getAllByRole('row')[1]
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent.trim())
    expect(cells).toEqual(['1', 'Widget', '36', '$2.50', '$90.00'])
  })

  it('totals the invoice and shows what is still owed', async () => {
    get.mockResolvedValue({
      data: {
        ...PAYLOAD,
        payment_status: 'PARTIALLY_PAID',
        paid_amount: '40.00',
        remaining_amount: '58.00',
      },
    })
    renderAt()

    await screen.findByText('Subtotal')
    // getAllByText: 'Total' is also a column header in the line table.
    expect(screen.getAllByText('Total', { exact: true }).length).toBeGreaterThan(0)
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getByText('Balance')).toBeInTheDocument()
    expect(screen.getByText('PARTIALLY PAID')).toBeInTheDocument()
  })

  it('shows the LBP conversion the seller account is configured for', async () => {
    renderAt()
    // 98 * 89,000 — the same secondary line the seller's own invoice prints.
    expect(await screen.findAllByText('8,722,000 LBP')).not.toHaveLength(0)
  })

  it('omits every conversion when the account is single-currency', async () => {
    get.mockResolvedValue({ data: { ...PAYLOAD, dual_currency: false } })
    renderAt()

    await screen.findByText('Subtotal')
    expect(screen.queryByText(/LBP/)).not.toBeInTheDocument()
  })

  it('carries the class the print stylesheet targets', async () => {
    // index.css hangs the whole @media print block off .invoice-print. Without it the
    // customer prints the app chrome instead of the document.
    const { container } = renderAt()
    await screen.findByText('Beirut Hardware')
    expect(container.querySelector('.invoice-print')).not.toBeNull()
  })

  it('keeps the action buttons out of the printed sheet', async () => {
    renderAt()
    const print = await screen.findByRole('button', { name: /print/i })
    expect(print.closest('.no-print')).not.toBeNull()
  })
})

describe('PublicInvoice actions', () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: PAYLOAD })
  })

  it('prints the document', async () => {
    const user = userEvent.setup()
    const print = vi.fn()
    vi.stubGlobal('print', print)

    renderAt()
    await user.click(await screen.findByRole('button', { name: /print/i }))
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('downloads a real PDF named after the invoice', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL,
    }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderAt()
    await user.click(await screen.findByRole('button', { name: /download pdf/i }))

    expect(click).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    const [file] = createObjectURL.mock.calls[0]
    expect(file.type).toBe('application/pdf')
    expect(file.name).toBe('Invoice_2026-08-04_C7BD9F4A.pdf')
    // A PDF, not a stub: the header is the first four bytes of any valid file.
    expect(await file.slice(0, 4).text()).toBe('%PDF')
  })
})

describe('PublicInvoice errors', () => {
  it('explains a dead link instead of showing an empty document', async () => {
    // 404 covers a wrong token and a revoked one alike — revoking nulls the column the
    // lookup uses, so the two are indistinguishable by design.
    get.mockRejectedValue(httpError(404))
    renderAt('nope')

    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument()
    expect(screen.getByText(/expired, or the business may have revoked it/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('does not offer a customer a way into the app', async () => {
    // The reader is a customer, not a user of this product: a "Sign in" link is an invitation
    // to a door they have no key for.
    get.mockRejectedValue(httpError(404))
    const { container } = renderAt('nope')

    await screen.findByText(/no longer valid/i)
    expect(container.querySelector('a')).toBeNull()
    expect(screen.queryByText(/sign in|log in/i)).not.toBeInTheDocument()
  })

  it('distinguishes a throttled link from a dead one', async () => {
    get.mockRejectedValue(httpError(429))
    renderAt()
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
  })

  it('reports a server failure without claiming the link is invalid', async () => {
    get.mockRejectedValue(httpError(500))
    renderAt()
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
    expect(screen.queryByText(/no longer valid/i)).not.toBeInTheDocument()
  })

  it('reports a network failure separately', async () => {
    get.mockRejectedValue(new Error('Network Error'))
    renderAt()
    expect(await screen.findByText(/could not reach the invoice/i)).toBeInTheDocument()
  })

  it('ignores an aborted request rather than painting an error over it', async () => {
    // Unmounting mid-flight aborts. Treating that as a failure would flash the dead-link card
    // on a page that is going away, and on a token change would replace the load that
    // superseded it.
    get.mockRejectedValue(
      Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }),
    )
    renderAt()

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByText(/no longer valid/i)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/loading invoice/i)
  })

  it('aborts the request when the reader navigates away', async () => {
    get.mockReturnValue(new Promise(() => {}))
    const { unmount } = renderAt()

    const { signal } = get.mock.calls[0][1]
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
