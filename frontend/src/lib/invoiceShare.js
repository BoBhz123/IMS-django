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
 * **Since 2026-08-26 the link path is what the invoice's Share menu uses**, because a link
 * can be addressed to the customer's own number and carry the public invoice URL, and the
 * OS share sheet can do neither: no web page may preselect a recipient for a file share.
 * `shareInvoiceFile` below is kept whole — it is the only way to send the bytes themselves,
 * and the decision to prefer an addressed link over an attachment is the caller's to make.
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

/* --- the public invoice link -------------------------------------------------------------- */

/**
 * The customer-facing URL for a share token, on whichever host is serving this page.
 *
 * Derived from `window.location.origin` for the same reason `lib/api.js` derives its base
 * URL that way: one bundle is served from the apex, from every subdomain, and from a LAN or
 * tunnel URL in development. A link built from a fixed domain is unopenable while testing
 * locally — the token exists only in the local database, and the link points at production,
 * which has never heard of it.
 *
 * This deliberately replaces the server's `share_url`, which is composed from `SITE_URL`.
 * The trade is real and worth stating: a staff member working on a subdomain now sends links
 * on that subdomain rather than on the canonical apex. Both serve the same SPA, so both
 * open; the local-development case is the one that was actually broken.
 *
 * Returns null for a missing token rather than a URL ending in `undefined` — a caller with
 * no link must omit it, not send a broken one.
 */
export function publicInvoiceUrl(shareToken) {
  if (!shareToken) return null
  if (typeof window === 'undefined') return null
  return `${window.location.origin}/i/${shareToken}`
}

/* --- the text fallback -------------------------------------------------------------------- */

/**
 * A one-line summary for the message: reference, seller, total, and the public invoice link.
 *
 * The link is the delivery mechanism, not a decoration — the recipient opens it to read the
 * invoice and save the PDF, which is why a share may now carry a URL back into this app.
 * That reverses the earlier "no URL in a share" rule, and the reason it is safe to reverse
 * is unchanged from what made the rule necessary: the URL is a capability. Anyone holding it
 * reads that customer's name, phone and order lines with no login. It is minted per invoice,
 * revocable, and must never be built by hand from an id — only from a real `share_token`.
 *
 * `formatPrimary` is injected so the total reads in the account's own display currency, the
 * same way the document does. `invoiceUrl` is optional: a purchase invoice has no public
 * link, and a mint that failed must still produce a sendable message.
 */
export function buildShareSummary({ reference, sellerName, total, formatPrimary, invoiceUrl }) {
  const who = sellerName ? ` — ${sellerName}` : ''
  const link = invoiceUrl ? ` · View invoice: ${invoiceUrl}` : ''
  return `Invoice #${reference}${who} · Total: ${formatPrimary(total)}${link}`
}

/** E.164 allows 15 digits at most, and no real international number is shorter than 8. */
const MIN_E164_DIGITS = 8
const MAX_E164_DIGITS = 15

/**
 * A phone number reduced to what WhatsApp accepts, or '' when it cannot be trusted.
 *
 * WhatsApp wants E.164 *without* the leading `+`: country code then subscriber number,
 * digits only. The `+` matters more than it looks — in a query string `+` is a literal
 * space, so `?phone=+96171999888` arrives as `" 96171999888"` and the chat silently fails
 * to open. Stripping it sidesteps the encoding question entirely and is what WhatsApp's own
 * documentation asks for.
 *
 * The refusals are the important part, because the failure they prevent is *sending a
 * customer's invoice to a stranger*:
 *
 *   - **A leading `0` with no `+`** is a national trunk prefix — `03 123 456` is a complete
 *     number inside its own country and meaningless outside it. Turning it into E.164 needs
 *     a country code this app does not store (there is no country on `Account`, and guessing
 *     Lebanon would be wrong for every other account). Refused, so the send falls back to
 *     the contact picker and a human chooses.
 *   - **Too few or too many digits** is not a phone number: a typo, an extension, a note in
 *     the field. `n/a` and `-` reduce to nothing at all.
 *
 * `00` is the other international prefix and is accepted, since it carries a country code.
 *
 * The gap worth knowing about: a bare `71999888` stored without a country code passes the
 * length test and is sent as-is, because nothing distinguishes it from a short-country-code
 * international number. Storing numbers with a `+` is what makes this reliable.
 */
export function normalizePhone(phone) {
  const raw = String(phone ?? '').trim()
  const digits = raw.replace(/\D/g, '')

  let candidate = digits
  if (!raw.startsWith('+')) {
    if (digits.startsWith('00')) candidate = digits.slice(2)
    else if (digits.startsWith('0')) return ''
  }

  if (candidate.length < MIN_E164_DIGITS || candidate.length > MAX_E164_DIGITS) return ''
  return candidate
}

/**
 * A WhatsApp deep link, addressed to the customer when we have a number we can trust.
 *
 * One endpoint for both cases, differing only in whether `phone` is present:
 *
 *   - with it, WhatsApp opens that customer's chat with the message prefilled and the seller
 *     just presses send;
 *   - without it, the same URL opens WhatsApp on the contact picker carrying the same
 *     message, and the seller chooses the recipient.
 *
 * The whole message — including the public invoice link — travels in `text`. There is no
 * separate URL field in either form.
 */
export function whatsappShareUrl(message, { phone } = {}) {
  const params = new URLSearchParams()

  // Omitted entirely rather than sent empty. `phone=` with nothing after it is not the same
  // request as no phone at all: WhatsApp reads it as an address it cannot resolve and shows
  // an error instead of the contact picker.
  const number = normalizePhone(phone)
  if (number) params.set('phone', number)
  params.set('text', message)

  return `https://api.whatsapp.com/send?${params.toString()}`
}

/**
 * Telegram takes `url` and `text` separately, and renders the URL as a link preview.
 *
 * **There is no phone parameter, and this is not an oversight to be fixed.** Telegram
 * identifies a recipient by chat id or @username, and has no way to open a chat with a bare
 * phone number — `t.me/share/url` always opens the contact picker. So the customer's number
 * is unusable here even though we hold it, and Telegram sharing stays "compose to whoever
 * you pick" while WhatsApp can be addressed.
 */
export function telegramShareUrl(message, { url } = {}) {
  const params = new URLSearchParams()
  params.set('url', url || '')
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
