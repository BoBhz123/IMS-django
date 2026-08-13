import { Printer } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatLBP, formatMoney, invoiceFileName, shortId } from '@/lib/format'
import { INVOICE_FOOTER_NOTE, INVOICE_TAGLINE } from '@/lib/invoiceConfig'
import { useSellerIdentity } from '@/hooks/useSellerIdentity'

/**
 * The printable document for one order or purchase.
 *
 * Two constraints shape it. It has to read as a real invoice on paper — letterhead, BILL TO,
 * a numbered line table, totals, a paid stamp — and it has to survive being printed from a
 * phone, which is where most of these are produced. The print rules live in index.css under
 * `@media print`; everything here is written so those rules have something sane to work on:
 * no fixed pixel widths, no card chrome that has to be stripped back off, and a table that
 * can reflow narrow.
 *
 * `paid` is not read from a payment-status column — this app has none. These are cash-sale
 * records written after the money moved, so the document is a receipt and the badge carries
 * the transaction's own date.
 */
export function Invoice({
  open,
  onClose,
  documentType,
  id,
  placedAt,
  exchangeRate,
  partyLabel,
  partyName,
  partyPhone,
  partyLocation,
  items,
}) {
  const seller = useSellerIdentity()

  const rows = items.map((item) => ({
    ...item,
    lineTotal: item.quantity * item.unitMultiplier * item.unitPrice,
  }))
  const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)
  // Subtotal and total are the same figure today — there is no discount, tax or shipping
  // model in this app. Both lines are printed anyway because the reference layout has both
  // and a reader looks for them; when a discount does arrive, only `total` changes.
  const total = subtotal

  function handlePrint() {
    // Browsers use document.title as the suggested filename for "Save as PDF" — there's no
    // other API for this. Swap it in right before printing and restore on `afterprint`
    // (not immediately after window.print(), which doesn't reliably block until the print
    // dialog has actually read the title on every browser/platform).
    const originalTitle = document.title
    document.title = invoiceFileName(placedAt, id)
    function restoreTitle() {
      document.title = originalTitle
      window.removeEventListener('afterprint', restoreTitle)
    }
    window.addEventListener('afterprint', restoreTitle)
    window.print()
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-3xl">
      <div className="invoice-print rounded-squircle bg-white p-5 text-black sm:p-8 print:block print:fixed print:inset-0 print:top-0 print:left-0 print:z-[999] print:h-auto print:w-full print:overflow-visible print:rounded-none print:shadow-none">
        <div className="no-print print:hidden mb-4 flex justify-end">
          <button
            type="button"
            onClick={handlePrint}
            className="flex items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Printer size={14} />
            Print / Save PDF
          </button>
        </div>

        <div className="invoice-page">
          {/* Letterhead: who is billing, and which document this is. No logo and no seller
              address — neither is in the reference layout, and neither is stored per account. */}
          <div className="avoid-break mb-6 flex flex-col gap-4 border-b-2 border-[#4F46E5] pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-display text-[20px] leading-tight font-bold break-words text-slate-900">
                {seller.name}
              </p>
              <div className="mt-1 flex flex-col text-[12px] text-slate-500">
                {seller.phone && <span className="tabular-nums">{seller.phone}</span>}
                {seller.email && <span className="break-all">{seller.email}</span>}
              </div>
            </div>
            <div className="shrink-0 sm:text-right">
              <p className="font-display text-[22px] leading-tight font-bold tracking-tight text-[#4F46E5] uppercase">
                {documentType}
              </p>
              <p className="text-[13px] font-semibold text-slate-900 tabular-nums">
                #{shortId(id)}
              </p>
              <p className="text-[12px] text-slate-500">{formatDate(placedAt)}</p>
            </div>
          </div>

          {/* BILL TO, and the paid stamp beside it. */}
          <div className="avoid-break mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-[0.08em] text-slate-400 uppercase">
                Bill to
              </p>
              <p className="mt-1 text-[14px] font-semibold break-words text-slate-900">
                {/* A walk-in sale has no customer row at all — naming the document's party
                    label beats printing an empty line or a bare dash. */}
                {partyName || `Walk-in ${partyLabel.toLowerCase()}`}
              </p>
              {partyLocation && (
                <p className="text-[12px] break-words text-slate-500">{partyLocation}</p>
              )}
              {partyPhone && <p className="text-[12px] text-slate-500 tabular-nums">{partyPhone}</p>}
              {!partyLocation && !partyPhone && (
                <p className="text-[12px] text-slate-400">No address on file</p>
              )}
            </div>

            <div className="shrink-0">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#0F9D58] px-3 py-1.5 text-[13px] font-bold tracking-[0.08em] text-white uppercase">
                Paid
              </span>
              <p className="mt-1 text-[11px] text-slate-500 sm:text-right">
                {formatDate(placedAt)}
              </p>
            </div>
          </div>

          <div className="-mx-1 overflow-x-auto px-1 print:mx-0 print:overflow-visible print:px-0">
            <table className="w-full min-w-[520px] border-collapse text-left text-[13px] print:min-w-0">
              <thead>
                <tr className="bg-[#4F46E5] text-[10px] tracking-[0.06em] text-white uppercase">
                  <th className="w-8 px-2 py-2.5 text-center font-bold">#</th>
                  <th className="px-3 py-2.5 font-bold">Items</th>
                  <th className="w-16 px-2 py-2.5 text-center font-bold">Unit</th>
                  <th className="w-14 px-2 py-2.5 text-right font-bold">Qty</th>
                  <th className="w-24 px-3 py-2.5 text-right font-bold">Unit cost</th>
                  <th className="w-24 px-3 py-2.5 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className={index % 2 === 1 ? 'bg-[#F1F5F9]' : 'bg-white'}>
                    <td className="border-b border-slate-200 px-2 py-2.5 text-center text-slate-400 tabular-nums">
                      {index + 1}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2.5 text-slate-900">
                      {row.name}
                    </td>
                    {/* Units per pack, i.e. unit_multiplier — the same number stock is
                        deducted by. Shown as a bare count so a case of 12 reads "12", and
                        loose goods read "1" rather than an empty cell. */}
                    <td className="border-b border-slate-200 px-2 py-2.5 text-center text-slate-500 tabular-nums">
                      {row.unitMultiplier}
                    </td>
                    <td className="border-b border-slate-200 px-2 py-2.5 text-right text-slate-500 tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2.5 text-right text-slate-500 tabular-nums">
                      {formatMoney(row.unitPrice)}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2.5 text-right font-medium text-slate-900 tabular-nums">
                      {formatMoney(row.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="avoid-break mt-5 flex justify-end">
            <div className="w-full sm:w-72">
              <div className="flex items-baseline justify-between py-1 text-[13px]">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-medium text-slate-900 tabular-nums">
                  {formatMoney(subtotal)}
                </span>
              </div>
              {exchangeRate > 0 && (
                <div className="flex items-baseline justify-between pb-2 text-[11px]">
                  <span className="text-slate-400">Subtotal (LBP)</span>
                  <span className="text-slate-500 tabular-nums">
                    {formatLBP(subtotal, exchangeRate)}
                  </span>
                </div>
              )}

              <div className="flex items-baseline justify-between border-t-2 border-slate-900 pt-2 text-[15px]">
                <span className="font-bold tracking-wide text-slate-900 uppercase">Total</span>
                <span className="font-display font-bold text-slate-900 tabular-nums">
                  {formatMoney(total)}
                </span>
              </div>
              {/* The secondary figure, only when a rate was recorded. LBP is presentation
                  here and nothing else — the stored amount is USD, and this multiplies it for
                  reading. See the USD-only rule in CLAUDE.md. */}
              {exchangeRate > 0 && (
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-slate-400">Total (LBP)</span>
                  <span className="font-medium text-slate-600 tabular-nums">
                    {formatLBP(total, exchangeRate)}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="avoid-break mt-8 border-t border-slate-200 pt-4 text-center">
            <p className="text-[13px] font-semibold text-slate-700">{INVOICE_TAGLINE}</p>
            <p className="mt-1 text-[11px] text-slate-400">{INVOICE_FOOTER_NOTE}</p>
          </div>
        </div>
      </div>
    </Modal>
  )
}
