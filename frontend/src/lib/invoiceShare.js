/**
 * Share-message construction for an invoice.
 *
 * Pure string building, kept out of React so the wording and the URL encoding can be tested
 * without rendering anything — a share link that loses its line breaks or double-encodes its
 * URL is invisible until a customer receives it.
 */

const STATUS_LABEL = {
  PAID: 'PAID',
  PARTIALLY_PAID: 'PARTIALLY PAID',
  UNPAID: 'UNPAID',
}

/** Human label for a payment status, safe for an unknown value from an older payload. */
export function paymentLabel(status) {
  return STATUS_LABEL[status] ?? 'UNPAID'
}

/**
 * The plain-text summary sent to WhatsApp or Telegram.
 *
 * `formatPrimary`/`formatSecondary` are injected rather than imported so the message renders
 * in whatever currency the account is configured for, and omits the conversion line entirely
 * when dual display is off — `formatSecondary` returns null in that mode.
 */
export function buildShareMessage({
  reference,
  sellerName,
  total,
  paymentStatus,
  paidAmount = 0,
  remainingAmount = 0,
  itemCount,
  shareUrl,
  formatPrimary,
  formatSecondary = () => null,
}) {
  const lines = []
  lines.push(`Invoice ${reference}${sellerName ? ` — ${sellerName}` : ''}`)

  const converted = formatSecondary(total)
  lines.push(
    `${itemCount} ${itemCount === 1 ? 'item' : 'items'} · Total ${formatPrimary(total)}` +
      (converted ? ` (${converted})` : ''),
  )

  const status = paymentLabel(paymentStatus)
  if (paymentStatus === 'PAID') {
    lines.push(`${status} · ${formatPrimary(paidAmount)}`)
  } else if (paymentStatus === 'PARTIALLY_PAID') {
    lines.push(
      `${status} · Paid ${formatPrimary(paidAmount)} · Balance ${formatPrimary(remainingAmount)}`,
    )
  } else {
    lines.push(`${status} · Balance ${formatPrimary(remainingAmount)}`)
  }

  if (shareUrl) lines.push(shareUrl)
  return lines.join('\n')
}

/**
 * wa.me takes the whole message as one encoded `text` parameter — there is no separate URL
 * field, so the link has to live inside the message body.
 */
export function whatsappShareUrl(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * Telegram takes the URL and the text separately. `url` must still be encoded on its own:
 * Telegram renders the preview from it, and an unencoded one truncates at the first `&`.
 * With no shareable URL the text alone is still valid.
 */
export function telegramShareUrl(message, shareUrl) {
  const params = new URLSearchParams()
  params.set('url', shareUrl || '')
  params.set('text', message)
  return `https://t.me/share/url?${params.toString()}`
}
