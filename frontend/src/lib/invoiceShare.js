/**
 * Sharing an invoice as a document.
 *
 * There is deliberately no message-building here any more. This module used to compose a
 * plain-text summary and encode it into wa.me / t.me share URLs; both are gone, because a
 * share now carries the PDF itself and no link to this application. See the block comment
 * below for why a link cannot carry a file, and what replaced it.
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
 * unsupported the caller downloads the PDF instead of opening a share URL: a wa.me link
 * cannot attach the file, so sending one would deliver a link to a web page under the label
 * "share the invoice", which is the thing this was changed to stop doing. A download at
 * least leaves the reader holding the actual document to attach by hand.
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
 */
export async function shareInvoiceFile({ file, title, text }) {
  if (!canShareFiles(file)) return 'unsupported'

  const payload = { files: [file] }
  if (title) payload.title = title
  if (text) payload.text = text

  try {
    await navigator.share(payload)
    return 'shared'
  } catch (error) {
    if (error?.name === 'AbortError') return 'dismissed'
    return 'error'
  }
}
