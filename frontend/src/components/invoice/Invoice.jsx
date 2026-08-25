import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Printer, Send, Share2, X } from 'lucide-react'
import {
  canShareFiles,
  makeInvoiceFile,
  paymentLabel,
  shareInvoiceFile,
} from '@/lib/invoiceShare'
import { invoicePdfBlob } from '@/lib/invoicePdf'
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
  // Passed in rather than read from CurrencyContext on purpose: this component is a printable
  // document, and keeping it free of context makes it renderable from anywhere (print view,
  // a future PDF path, its own tests) without a provider. Orders/Purchases supply the account's
  // real settings; the defaults keep a bare <Invoice> rendering as it always did.
  primaryCurrency = 'USD',
  showSecondaryCurrency = true,
  // Payment state. Defaulted so a bare <Invoice> — or an older cached payload — renders
  // without a stamp rather than crashing on an undefined status.
  paymentStatus = null,
  paidAmount = 0,
  remainingAmount = 0,
  // Sharing. `shareUrl` is null until the order has actually been shared; onShare mints it.
  shareUrl = null,
  onShare = null,
  sharing = false,
}) {
  const seller = useSellerIdentity()

  const secondaryCode = primaryCurrency === 'USD' ? 'LBP' : 'USD'
  const primary = (usd) =>
    primaryCurrency === 'LBP' ? formatLBP(usd, exchangeRate) : formatMoney(usd)
  /** The converted figure, or null when it must not be shown — no rate, or dual display off. */
  const secondary = (usd) => {
    if (!showSecondaryCurrency || !(exchangeRate > 0)) return null
    return secondaryCode === 'LBP' ? formatLBP(usd, exchangeRate) : formatMoney(usd)
  }

  const rows = items.map((item) => ({
    ...item,
    lineTotal: item.quantity * item.unitPrice,
  }))
  const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)
  // Subtotal and total are the same figure today — there is no discount, tax or shipping
  // model in this app. Both lines are printed anyway because the reference layout has both
  // and a reader looks for them; when a discount does arrive, only `total` changes.
  const total = subtotal

  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef(null)
  const restorePrintTitleRef = useRef(null)
  const revokeRef = useRef(null)
  const objectUrlsRef = useRef([])

  useEffect(() => () => {
    clearTimeout(copyResetRef.current)
    clearTimeout(revokeRef.current)
    // An object URL pins its blob in memory until revoked. Unmounting before the deferred
    // revoke fires would strand a whole PDF per download for the life of the document.
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    objectUrlsRef.current = []
    // Runs the restore rather than only detaching it: unmounting mid-print must not leave the
    // browser tab named after an invoice.
    restorePrintTitleRef.current?.()
  }, [])

  /**
   * Renders the invoice to a PDF `File`.
   *
   * Synchronous on purpose. `navigator.share` must be called inside the user gesture that
   * triggered it, and awaiting anything first — a dynamic import, a fetch, a canvas render —
   * spends that gesture and makes the share throw on Safari. Building the bytes inline keeps
   * the whole path gesture-safe, which is the practical reason lib/pdf.js exists at all.
   */
  function buildInvoiceFile() {
    const blob = invoicePdfBlob({
      documentType,
      reference: shortId(id),
      placedAt,
      seller,
      partyLabel,
      partyName,
      partyPhone,
      partyLocation,
      rows,
      paymentStatus,
      paidAmount,
      remainingAmount,
      secondaryCode,
      formatPrimary: primary,
      formatSecondary: secondary,
      formatDate,
      tagline: INVOICE_TAGLINE,
      footerNote: INVOICE_FOOTER_NOTE,
    })
    return makeInvoiceFile(blob, invoiceFileName(placedAt, id))
  }

  function downloadPdfFile(file) {
    const url = URL.createObjectURL(file)
    objectUrlsRef.current.push(url)

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
      objectUrlsRef.current = objectUrlsRef.current.filter((held) => held !== url)
    }, 10000)
  }

  /**
   * Sends the invoice as a document — the PDF and nothing else.
   *
   * There is no link in this path. The share carries the file and a title; it does not carry
   * a URL back into this app, so what the recipient gets is the invoice rather than an
   * invitation to open a web page. That also means the public share link is no longer
   * involved in sending an invoice at all — it stays available under "Share invoice" and
   * "Copy link" for anyone who does want a URL.
   *
   * Where the platform cannot share files — Firefox, most desktop Linux — the fallback is a
   * download, not a wa.me link. A wa.me link cannot attach the file, so opening one would
   * deliver a web link under a button labelled "WhatsApp" and quietly reintroduce exactly
   * what this replaced. A download leaves the reader holding the real document to attach.
   */
  function handleSendPdf() {
    const file = buildInvoiceFile()

    if (!canShareFiles(file)) {
      downloadPdfFile(file)
      return
    }

    shareInvoiceFile({ file, title: `Invoice #${shortId(id)}` }).then((result) => {
      // A dismissal is the reader changing their mind and needs no recovery. A genuine
      // failure still has to leave them with the document.
      if (result === 'error') downloadPdfFile(file)
    })
  }

  function handleDownloadPdf() {
    downloadPdfFile(buildInvoiceFile())
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      // Reverts on its own — a permanently "Copied" button gives no feedback the second time.
      // Tracked in a ref so closing the invoice cancels it; this modal is closed within two
      // seconds of a copy often enough (copy the link, close, paste) for it to matter.
      clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied outside a secure context and in some embedded browsers.
      // The link is visible in the WhatsApp/Telegram targets either way, so this is a
      // degraded copy button rather than a broken share feature.
      setCopied(false)
    }
  }

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
      restorePrintTitleRef.current = null
    }

    // Also held in a ref, because `afterprint` is not guaranteed to arrive: some embedded and
    // mobile browsers never fire it, and the tab can be closed from the print preview. Without
    // an unmount path the listener outlives the invoice holding a captured title, and the next
    // print from a different order restores a filename from a document nobody has open.
    restorePrintTitleRef.current = restoreTitle
    window.addEventListener('afterprint', restoreTitle)
    window.print()
  }

  return (
    <Modal open={open} onClose={onClose} className="mx-auto w-full max-w-4xl overflow-x-auto shadow-lg">
      <div className="invoice-print rounded-squircle bg-white p-5 text-black sm:p-8 print:block print:fixed print:inset-0 print:top-0 print:left-0 print:z-[999] print:h-auto print:w-full print:overflow-visible print:rounded-none print:shadow-none">
        <div className="no-print print:hidden mb-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={handlePrint}
            className="flex items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Printer size={14} />
            Print / Save PDF
          </button>

          {/* The guaranteed path to the file, and the one action here that always produces
              the document regardless of platform — so it carries the app's red accent to
              stand out from the neutral chrome around it. `accent-red` rather than a raw
              `red-600`: the token is what shifts correctly between light and dark themes,
              which a hardcoded Tailwind colour does not. */}
          <button
            type="button"
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 rounded-xl bg-accent-red px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Download size={14} />
            Download PDF
          </button>

          {/* Sending the document. Both targets do the same thing — hand the PDF to the OS
              share sheet — because no web page can preselect an app for a file share; the
              sheet belongs to the OS and the reader picks from it. They are kept as two
              familiar affordances rather than one "Send" button, and neither depends on a
              public share link existing. */}
          <button
            type="button"
            onClick={handleSendPdf}
            className="flex items-center gap-1.5 rounded-xl bg-[#25D366] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Share2 size={14} />
            WhatsApp
          </button>
          <button
            type="button"
            onClick={handleSendPdf}
            className="flex items-center gap-1.5 rounded-xl bg-[#229ED9] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Send size={14} />
            Telegram
          </button>

          {/* Sharing is opt-in per invoice: the first press mints a public link (see
              PublicInvoiceView), so it is a deliberate act rather than something that happens
              because the invoice was opened. */}
          {onShare && !shareUrl && (
            <button
              type="button"
              onClick={onShare}
              disabled={sharing}
              className="flex items-center gap-1.5 rounded-xl border border-hairline px-3 py-1.5 text-[13px] font-semibold text-text-primary hover:bg-canvas-2 disabled:opacity-60"
            >
              <Share2 size={14} />
              {sharing ? 'Creating link…' : 'Share invoice'}
            </button>
          )}

          {shareUrl && (
            <button
              type="button"
              onClick={handleCopyLink}
              className="flex items-center gap-1.5 rounded-xl border border-hairline px-3 py-1.5 text-[13px] font-semibold text-text-primary hover:bg-canvas-2"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-xl border border-hairline px-3 py-1.5 text-[13px] font-semibold text-text-secondary hover:bg-canvas-2"
          >
            <X size={14} />
            Close
          </button>
        </div>

        {/* `invoice-preview` scales the document down on screen only — see index.css. The
            print rules key off `invoice-print` on the wrapper and are unaffected. */}
        <div className="invoice-page invoice-preview">
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
                  <th className="w-8 px-2 py-2 text-center font-bold">#</th>
                  <th className="px-3 py-2 font-bold">Items</th>
                  <th className="w-14 px-2 py-2 text-right font-bold">Qty</th>
                  <th className="w-24 px-3 py-2 text-right font-bold">Unit cost</th>
                  <th className="w-24 px-3 py-2 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className={index % 2 === 1 ? 'bg-[#F1F5F9]' : 'bg-white'}>
                    <td className="border-b border-slate-200 px-2 py-2 text-center text-slate-400 tabular-nums">
                      {index + 1}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2 text-slate-900">
                      {row.name}
                    </td>
                    <td className="border-b border-slate-200 px-2 py-2 text-right text-slate-500 tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2 text-right text-slate-500 tabular-nums">
                      {primary(row.unitPrice)}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2 text-right font-medium text-slate-900 tabular-nums">
                      {primary(row.lineTotal)}
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
                  {primary(subtotal)}
                </span>
              </div>
              {secondary(subtotal) && (
                <div className="flex items-baseline justify-between pb-2 text-[11px]">
                  <span className="text-slate-400">Subtotal ({secondaryCode})</span>
                  <span className="text-slate-500 tabular-nums">
                    {secondary(subtotal)}
                  </span>
                </div>
              )}

              <div className="flex items-baseline justify-between border-t-2 border-slate-900 pt-2 text-[15px]">
                <span className="font-bold tracking-wide text-slate-900 uppercase">Total</span>
                <span className="font-display font-bold text-slate-900 tabular-nums">
                  {primary(total)}
                </span>
              </div>
              {/* The dual-currency breakdown, shown only when the account asked for one and a
                  rate was recorded. Conversion is presentation and nothing else — the stored
                  amount is USD either way. See the USD-only rule in CLAUDE.md. */}
              {secondary(total) && (
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-slate-400">Total ({secondaryCode})</span>
                  <span className="font-medium text-slate-600 tabular-nums">
                    {secondary(total)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* The payment stamp. Angled and outlined like a rubber stamp because that is what
              a reader looks for on a paper invoice, and it carries the numbers rather than
              just a word — "PARTIALLY PAID" alone tells the customer nothing about what they
              still owe. */}
          {paymentStatus && (
            <div className="avoid-break mt-6 flex justify-end">
              <div
                className={`-rotate-6 rounded-lg border-[3px] px-4 py-2 text-center ${
                  paymentStatus === 'PAID'
                    ? 'border-emerald-600 text-emerald-700'
                    : paymentStatus === 'PARTIALLY_PAID'
                      ? 'border-amber-600 text-amber-700'
                      : 'border-red-600 text-red-700'
                }`}
              >
                <p className="font-display text-[18px] leading-none font-extrabold tracking-widest uppercase">
                  {paymentLabel(paymentStatus)}
                </p>
                {paymentStatus !== 'UNPAID' && (
                  <p className="mt-1 text-[11px] tabular-nums">Paid {primary(paidAmount)}</p>
                )}
                {paymentStatus !== 'PAID' && (
                  <p className="mt-0.5 text-[11px] font-semibold tabular-nums">
                    Balance {primary(remainingAmount)}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="avoid-break mt-8 border-t border-slate-200 pt-4 text-center">
            <p className="text-[13px] font-semibold text-slate-700">{INVOICE_TAGLINE}</p>
            <p className="mt-1 text-[11px] text-slate-400">{INVOICE_FOOTER_NOTE}</p>
          </div>
        </div>
      </div>
    </Modal>
  )
}
