/**
 * Sharing an invoice: the PDF where the platform can carry one, a text summary where it
 * cannot.
 *
 * Two paths, and which one runs is decided by the platform, never by the user:
 *
 *   - `navigator.share({ files })` hands the actual PDF to the OS share sheet. This is the
 *     real feature, and it is what runs on the phones these invoices are sent from.
 *   - Where that is unavailable — Firefox, most desktop Linux — a `wa.me` / `t.me` link
 *     opens with a short text summary. Those schemes cannot carry an attachment (no
 *     parameter exists for one and no encoding invents it), so the summary is all a link
 *     can deliver.
 *
 * The fallback is deliberately *not* a silent download. A press on "WhatsApp" that puts a
 * file in the downloads folder and opens nothing looks like the button is broken; the
 * download belongs to the button labelled "Download PDF" and nowhere else.
 *
 * The summary carries no URL back into this application — see `buildShareSummary`.
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

/* --- the text fallback -------------------------------------------------------------------- */

/**
 * A one-line summary for the link-based fallback: reference, seller, total.
 *
 * Deliberately short, and deliberately free of any URL into this app — a share must not
 * become an invitation to open a web page. `formatPrimary` is injected so the total reads in
 * the account's own display currency, the same way the document does.
 */
export function buildShareSummary({ reference, sellerName, total, formatPrimary }) {
  const who = sellerName ? ` — ${sellerName}` : ''
  return `Invoice #${reference}${who} · Total: ${formatPrimary(total)}`
}

/**
 * wa.me takes the whole message as one encoded `text` parameter — there is no separate URL
 * field, so everything to be said has to live inside the message body.
 */
export function whatsappShareUrl(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * Telegram takes `url` and `text` separately and expects both to be present. There is no URL
 * to send any more, so `url` goes empty and the summary travels as text — which Telegram
 * renders fine, and which keeps the "no link back into the app" rule intact.
 */
export function telegramShareUrl(message) {
  const params = new URLSearchParams()
  params.set('url', '')
  params.set('text', message)
  return `https://t.me/share/url?${params.toString()}`
}

/* --- sharing the document itself ---------------------------------------------------------
 *
 * A `wa.me` or `t.me/share/url` link carries text and a URL and nothing else — neither
 * scheme has a parameter for an attachment, and no amount of encoding adds one. Sending the
 * actual PDF therefore cannot go through those links at all; it goes through the Web Share
 * API, which hands the file to the OS share sheet where the reader picks WhatsApp, Telegram
 * or anything else installed.
 *
 * The consequence worth stating: a web page cannot preselect WhatsApp for a file share. The
 * sheet is the OS's, and choosing the target is the user's step. What the buttons below do
 * is put the real document into that sheet instead of a link to a web page.
 *
 * Support is real but not universal — Chrome on Android, Safari on iOS and Chrome/Edge on
 * Windows share files; Firefox does not, and desktop Linux generally does not. Where it is
 * unsupported the caller opens the wa.me / t.me link with `buildShareSummary` above, which
 * is the most a URL scheme can carry.
 */

/** Wraps a PDF blob as a `File`, which is what `navigator.share` requires. */
export function makeInvoiceFile(blob, fileName) {
  return new File([blob], fileName, { type: 'application/pdf' })
}

/**
 * Whether this browser can share this actual file.
 *
 * Tested with the real `File` rather than a bare capability check: `navigator.share` may
 * exist while file sharing specifically is unsupported, and `canShare` also rejects types
 * the platform will not accept. Guarded for jsdom and SSR, where `navigator.canShare` is
 * simply absent.
 */
export function canShareFiles(file) {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false
  }
  try {
    return navigator.canShare({ files: [file] })
  } catch {
    // Older implementations throw on an unexpected payload instead of returning false.
    return false
  }
}

/**
 * Hands the file to the OS share sheet.
 *
 * Resolves to one of 'shared' | 'dismissed' | 'unsupported' | 'error' rather than throwing,
 * because the caller's decision differs per outcome and only one of them is a failure worth
 * telling the user about. A dismissal is an AbortError — the reader opened the sheet and
 * changed their mind, which must not paint an error over a working feature.
 *
 * `title` and `text` are omitted from the payload when absent rather than passed as
 * undefined: some implementations validate the shape and an explicit `text: undefined` is
 * not the same as no text. The invoice path sends the file and a title only — no body, and
 * in particular no URL back into this application.
 *
 * NOT an `async function`, and that is load-bearing rather than style. `navigator.share`
 * must be invoked inside the user gesture that triggered it, and browsers judge that by the
 * call stack: an `await` anywhere before the call — even `await` on an already-resolved
 * value — moves it to a microtask, at which point Safari and Chrome on Android reject it
 * with NotAllowedError ("must be handling a user gesture"). Written this way the stack from
 * the click handler to `navigator.share` is unbroken and synchronous, and the promise is
 * returned rather than awaited. Do not add `async` back.
 */
export function shareInvoiceFile({ file, title, text }) {
  if (!canShareFiles(file)) return Promise.resolve('unsupported')

  const payload = { files: [file] }
  if (title) payload.title = title
  if (text) payload.text = text

  return navigator.share(payload).then(
    () => 'shared',
    (error) => (error?.name === 'AbortError' ? 'dismissed' : 'error'),
  )
}
