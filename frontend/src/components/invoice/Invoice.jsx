import { Printer } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { formatDate, formatLBP, formatMoney, invoiceFileName, shortId } from '@/lib/format'
import { INVOICE_SENDER_EMAIL, INVOICE_SENDER_NAME } from '@/lib/invoiceConfig'

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
  items,
}) {
  const rows = items.map((item) => ({
    ...item,
    lineTotal: item.quantity * item.unitMultiplier * item.unitPrice,
  }))
  const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)

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
    <Modal open={open} onClose={onClose} className="max-w-xl">
      <div className="invoice-print rounded-squircle bg-white p-8 print:block print:fixed print:inset-0 print:top-0 print:left-0 print:z-[999] print:h-auto print:w-full print:overflow-visible print:rounded-none print:p-0 print:text-black print:shadow-none">
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
          {/* Invoice badge: ID + creation date in an accent card */}
          <div className="mb-6 flex items-center justify-between rounded-2xl bg-[#4F46E5] px-5 py-4 text-white">
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-indigo-100 uppercase">{documentType}</p>
              <p className="font-display text-[20px] font-bold tabular-nums">#{shortId(id)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] tracking-wide text-indigo-100 uppercase">Date issued</p>
              <p className="text-[14px] font-semibold">{formatDate(placedAt)}</p>
            </div>
          </div>

          {/* Issuer (left) / customer or supplier (right) */}
          <div className="mb-6 grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] tracking-wide text-slate-400 uppercase">From</p>
              <p className="text-[14px] font-semibold text-slate-900">{INVOICE_SENDER_NAME}</p>
              <p className="text-[12px] text-slate-500">{INVOICE_SENDER_EMAIL}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] tracking-wide text-slate-400 uppercase">{partyLabel}</p>
              <p className="text-[14px] font-semibold text-slate-900">
                {partyName ?? `No ${partyLabel.toLowerCase()}`}
              </p>
              {partyPhone && <p className="text-[12px] text-slate-500">{partyPhone}</p>}
            </div>
          </div>

          <table className="w-full border-collapse overflow-hidden rounded-xl text-left text-[13px]">
            <thead>
              <tr className="bg-[#4F46E5]">
                <th className="rounded-tl-xl px-3 py-2.5 font-bold text-white">Item</th>
                <th className="px-3 py-2.5 text-right font-bold text-white">Qty</th>
                <th className="px-3 py-2.5 text-right font-bold text-white">Unit</th>
                <th className="rounded-tr-xl px-3 py-2.5 text-right font-bold text-white">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className={index % 2 === 1 ? 'bg-[#F8FAFC]' : 'bg-white'}>
                  <td className="border-b border-slate-100 px-3 py-2.5 text-slate-900">{row.name}</td>
                  <td className="border-b border-slate-100 px-3 py-2.5 text-right text-slate-500 tabular-nums">
                    {row.quantity}
                    {row.unitMultiplier > 1 ? ` × ${row.unitMultiplier}` : ''}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2.5 text-right text-slate-500 tabular-nums">
                    {formatMoney(row.unitPrice)}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2.5 text-right font-medium text-slate-900 tabular-nums">
                    {formatMoney(row.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="w-56 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex justify-between text-[14px]">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-bold text-slate-900 tabular-nums">{formatMoney(subtotal)}</span>
              </div>
              <div className="mt-1 flex justify-between text-[12px]">
                <span className="text-slate-400">In LBP</span>
                <span className="text-slate-500 tabular-nums">{formatLBP(subtotal, exchangeRate)}</span>
              </div>
            </div>
          </div>

          <p className="mt-8 text-center text-[11px] text-slate-400">Generated by IMS — not a fiscal document</p>
        </div>
      </div>
    </Modal>
  )
}
