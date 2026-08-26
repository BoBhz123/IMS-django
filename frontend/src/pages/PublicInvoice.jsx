import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Download, FileWarning, Printer } from 'lucide-react'
import { publicApi } from '@/lib/api'
import { invoicePdfBlob } from '@/lib/invoicePdf'
import { makeInvoiceFile, paymentLabel } from '@/lib/invoiceShare'
import { formatDate, formatLBP, formatMoney } from '@/lib/format'
import { INVOICE_FOOTER_NOTE, INVOICE_TAGLINE } from '@/lib/invoiceConfig'
import { BrandMark } from '@/components/ui/BrandMark'

/**
 * The invoice a customer sees after opening a share link. **No session, no account.**
 *
 * Everything on screen comes from `GET /inventory/public/invoice/<token>/`, which is the only
 * unauthenticated endpoint in this application. Nothing here may read AuthContext or
 * CurrencyContext: the reader has neither, and both are mounted above the protected routes
 * only. The seller's name and the display currency arrive in the payload for exactly that
 * reason — `useSellerIdentity` would render the fallback placeholder here, since there is no
 * account to read.
 *
 * The document is deliberately its own layout rather than the seller's <Invoice>, which is a
 * Modal, reads the seller from context, and carries Share controls that make no sense to a
 * customer. What is *not* duplicated is the part that has to stay identical: the PDF comes
 * from the same `invoicePdfBlob`, and printing keys off the same `.invoice-print` rules, so
 * the artefact the customer saves is byte-for-byte the document the seller sends.
 */
export function PublicInvoice() {
  const { token } = useParams()
  const [state, setState] = useState({ status: 'loading', invoice: null, error: null })
  const revokeRef = useRef(null)
  const objectUrlsRef = useRef([])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', invoice: null, error: null })

    publicApi
      .get(`/inventory/public/invoice/${encodeURIComponent(token)}/`, {
        signal: controller.signal,
      })
      .then(({ data }) => setState({ status: 'ready', invoice: data, error: null }))
      .catch((error) => {
        // An aborted request is an unmount or a token change, not a failure — painting an
        // error over it would replace the load that superseded it.
        if (error.name === 'CanceledError' || error.code === 'ERR_CANCELED') return
        setState({ status: 'error', invoice: null, error: statusOf(error) })
      })

    return () => controller.abort()
  }, [token])

  useEffect(() => () => {
    clearTimeout(revokeRef.current)
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    objectUrlsRef.current = []
  }, [])

  if (state.status === 'loading') return <CenteredCard><LoadingBody /></CenteredCard>
  if (state.status === 'error') {
    return <CenteredCard><ErrorBody status={state.error} /></CenteredCard>
  }

  return <InvoiceDocument invoice={state.invoice} revokeRef={revokeRef} urlsRef={objectUrlsRef} />
}

/** 404 covers both a wrong token and a revoked one — revoking nulls the column this looks up. */
function statusOf(error) {
  if (!error.response) return 'network'
  if (error.response.status === 404) return 'not_found'
  if (error.response.status === 429) return 'throttled'
  return 'server'
}

function InvoiceDocument({ invoice, revokeRef, urlsRef }) {
  const {
    reference, placed_at: placedAt, exchange_rate: exchangeRate,
    seller_name: sellerName, seller_phone: sellerPhone,
    customer_name: customerName, customer_phone: customerPhone,
    customer_location: customerLocation,
    items = [], total_price: totalPrice,
    payment_status: paymentStatus, paid_amount: paidAmount, remaining_amount: remainingAmount,
    primary_currency: primaryCurrency = 'USD', dual_currency: dualCurrency = true,
  } = invoice

  const rate = Number(exchangeRate) || 0
  const secondaryCode = primaryCurrency === 'LBP' ? 'USD' : 'LBP'

  const primary = (usd) => (primaryCurrency === 'LBP' ? formatLBP(usd, rate) : formatMoney(usd))
  /** Null when the conversion must not be shown — no rate recorded, or the account is
   *  single-currency. Every caller renders the line only when this returns a string. */
  const secondary = (usd) => {
    if (!dualCurrency || !(rate > 0)) return null
    return secondaryCode === 'LBP' ? formatLBP(usd, rate) : formatMoney(usd)
  }

  const rows = items.map((item) => ({
    name: item.product,
    quantity: Number(item.quantity) || 0,
    unitPrice: Number(item.unit_price) || 0,
    lineTotal: Number(item.line_total) || 0,
  }))
  const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)
  // Subtotal and total are the same figure: this app has no discount, tax or shipping model.
  // Both lines are printed because a reader looks for them, and when a discount does arrive
  // only the total moves.
  const total = Number(totalPrice) || subtotal
  const paid = Number(paidAmount) || 0
  const remaining = Number(remainingAmount) || 0

  const fileName = `Invoice_${String(placedAt).slice(0, 10)}_${reference}.pdf`

  function handleDownload() {
    const blob = invoicePdfBlob({
      documentType: 'Invoice',
      reference,
      placedAt,
      seller: { name: sellerName, phone: sellerPhone, email: '' },
      partyLabel: 'Customer',
      partyName: customerName,
      partyPhone: customerPhone,
      partyLocation: customerLocation,
      rows,
      paymentStatus,
      paidAmount: paid,
      remainingAmount: remaining,
      secondaryCode,
      formatPrimary: primary,
      formatSecondary: secondary,
      formatDate,
      tagline: INVOICE_TAGLINE,
      footerNote: INVOICE_FOOTER_NOTE,
    })

    const file = makeInvoiceFile(blob, fileName)
    const url = URL.createObjectURL(file)
    urlsRef.current.push(url)

    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    link.remove()

    // Revoking synchronously cancels the download in Firefox and older WebKit — the browser
    // has not finished reading the blob when the handler returns.
    clearTimeout(revokeRef.current)
    revokeRef.current = setTimeout(() => {
      URL.revokeObjectURL(url)
      urlsRef.current = urlsRef.current.filter((held) => held !== url)
    }, 10000)
  }

  return (
    <div className="min-h-screen bg-canvas px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BrandMark size={22} className="rounded-md" />
            <span className="text-[13px] font-semibold text-text-secondary">Invoice</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              <Printer size={14} />
              Print
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-xl bg-accent-red px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              <Download size={14} />
              Download PDF
            </button>
          </div>
        </div>

        {/* `invoice-print` is what the @media print block keys off: it hides the rest of the
            page and lays this out to the sheet. Same class the seller's invoice uses, so the
            customer's printout and the seller's are the same document. */}
        <div className="invoice-print rounded-squircle bg-white p-5 text-black shadow-lg sm:p-8">
          <div className="avoid-break mb-6 flex flex-col gap-4 border-b-2 border-[#4F46E5] pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-display text-[20px] leading-tight font-bold break-words text-slate-900">
                {sellerName}
              </p>
              {sellerPhone && (
                <p className="mt-1 text-[12px] text-slate-500 tabular-nums">{sellerPhone}</p>
              )}
            </div>
            <div className="shrink-0 sm:text-right">
              <p className="font-display text-[22px] leading-tight font-bold tracking-tight text-[#4F46E5] uppercase">
                Invoice
              </p>
              <p className="text-[13px] font-semibold text-slate-900 tabular-nums">
                #{reference}
              </p>
              <p className="text-[12px] text-slate-500">{formatDate(placedAt)}</p>
            </div>
          </div>

          <div className="avoid-break mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-[0.08em] text-slate-400 uppercase">
                Bill to
              </p>
              <p className="mt-1 text-[14px] font-semibold break-words text-slate-900">
                {customerName || 'Walk-in customer'}
              </p>
              {customerLocation && (
                <p className="text-[12px] break-words text-slate-500">{customerLocation}</p>
              )}
              {customerPhone && (
                <p className="text-[12px] text-slate-500 tabular-nums">{customerPhone}</p>
              )}
            </div>
            {paymentStatus && (
              <div className="shrink-0 sm:text-right">
                <span
                  className={`inline-block rounded-lg border px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase ${
                    paymentStatus === 'PAID'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-amber-200 bg-amber-50 text-amber-700'
                  }`}
                >
                  {paymentLabel(paymentStatus)}
                </span>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] tracking-[0.08em] text-slate-400 uppercase">
                  <th className="py-2 pr-2 text-left font-bold">#</th>
                  <th className="py-2 pr-2 text-left font-bold">Items</th>
                  <th className="py-2 pr-2 text-right font-bold">Qty</th>
                  <th className="py-2 pr-2 text-right font-bold">Unit cost</th>
                  <th className="py-2 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.name}-${index}`} className="avoid-break border-b border-slate-100">
                    <td className="py-2 pr-2 text-slate-400 tabular-nums">{index + 1}</td>
                    <td className="py-2 pr-2 break-words text-slate-900">{row.name}</td>
                    <td className="py-2 pr-2 text-right text-slate-700 tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="py-2 pr-2 text-right text-slate-700 tabular-nums">
                      {primary(row.unitPrice)}
                    </td>
                    <td className="py-2 text-right font-medium text-slate-900 tabular-nums">
                      {primary(row.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="avoid-break mt-6 flex justify-end">
            <div className="w-full sm:w-72">
              <TotalRow label="Subtotal" value={primary(subtotal)} secondary={secondary(subtotal)} />
              <div className="my-2 h-px bg-slate-200" />
              <TotalRow label="Total" value={primary(total)} secondary={secondary(total)} strong />
              {paid > 0 && (
                <TotalRow label="Paid" value={primary(paid)} secondary={secondary(paid)} />
              )}
              {remaining > 0 && (
                <TotalRow
                  label="Balance"
                  value={primary(remaining)}
                  secondary={secondary(remaining)}
                />
              )}
            </div>
          </div>

          <div className="avoid-break mt-8 border-t border-slate-200 pt-4 text-center">
            <p className="text-[13px] font-medium text-slate-700">{INVOICE_TAGLINE}</p>
            <p className="mt-1 text-[11px] text-slate-400">{INVOICE_FOOTER_NOTE}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function TotalRow({ label, value, secondary, strong = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className={`text-[12px] ${strong ? 'font-bold text-slate-900' : 'text-slate-500'}`}>
        {label}
      </span>
      <span className="text-right">
        <span
          className={`tabular-nums ${
            strong ? 'text-[16px] font-bold text-slate-900' : 'text-[13px] text-slate-700'
          }`}
        >
          {value}
        </span>
        {secondary && <span className="block text-[11px] text-slate-400">{secondary}</span>}
      </span>
    </div>
  )
}

function CenteredCard({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-squircle border border-glass-border bg-glass-strong p-8 text-center backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
        {children}
      </div>
    </div>
  )
}

function LoadingBody() {
  return (
    <>
      <BrandMark size={40} className="mx-auto rounded-xl" />
      <p className="mt-4 text-[14px] font-semibold text-text-primary">Loading invoice…</p>
      <div className="mt-4 space-y-2" aria-hidden="true">
        <div className="h-2 animate-pulse rounded bg-canvas-2" />
        <div className="h-2 w-4/5 animate-pulse rounded bg-canvas-2" />
      </div>
      {/* The visible skeleton is decorative; this is what a screen reader is told. */}
      <span role="status" className="sr-only">Loading invoice</span>
    </>
  )
}

const ERROR_COPY = {
  // A revoked link and a wrong one are indistinguishable by design: revoking destroys the
  // token rather than flagging it, so the lookup simply finds nothing. Saying "expired or
  // revoked" covers both without implying the invoice never existed.
  not_found: {
    title: 'This invoice link is no longer valid',
    body: 'The link may have expired, or the business may have revoked it. Ask them to send you a new one.',
  },
  throttled: {
    title: 'Too many attempts',
    body: 'This link has been opened too many times in a short period. Please wait a minute and try again.',
  },
  network: {
    title: 'Could not reach the invoice',
    body: 'Check your connection and try again.',
  },
  server: {
    title: 'Something went wrong',
    body: 'The invoice could not be loaded right now. Please try again in a moment.',
  },
}

function ErrorBody({ status }) {
  const copy = ERROR_COPY[status] ?? ERROR_COPY.server

  return (
    <>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-red/10 text-accent-red">
        <FileWarning size={22} />
      </div>
      <h1 className="mt-4 font-display text-[17px] font-semibold text-text-primary">
        {copy.title}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{copy.body}</p>
      {/* No link back into the app: the reader is a customer, not a user of this product, and
          "Sign in" is an invitation to a door they have no key for. */}
    </>
  )
}
