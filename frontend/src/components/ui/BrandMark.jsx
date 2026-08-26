import { useId } from 'react'

/**
 * The IMS brand mark: three descending bars in a rounded tile — an inventory stack seen
 * edge-on.
 *
 * This is the third drawing of one logo, and the three have to stay in step:
 *   - `frontend/public/favicon-v2.svg`               — the browser tab and PWA icon
 *   - `accounts/templates/emails/otp_code.html`      — drawn from table cells, because the
 *     email tests forbid remote content and Word's renderer is the constraint there
 *   - this component                                 — everywhere inside the SPA
 *
 * Change the bar colours or the silhouette and change all three, or the tab, the
 * verification email and the sign-in screen start showing different logos for one product.
 *
 * Inlined as JSX rather than `<img src="/favicon-v2.svg">` on purpose: an <img> is a second
 * network request for ~1 kB of markup, cannot inherit `currentColor` or a size from its
 * container, and paints late enough to be visible as a flash on the sign-in card.
 */
export function BrandMark({ size = 32, className = '', title = 'IMS' }) {
  // The gradient needs a document-unique id: two marks on one page sharing `ims-tile` is a
  // duplicate DOM id, and the second instance resolves url(#ims-tile) to the first one's
  // definition. React 19's useId returns «r0»-style values, whose delimiters are not safe
  // inside a url(#…) reference, so strip everything that is not id-safe.
  const gradientId = `ims-tile-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const labelled = Boolean(title)

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : 'true'}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="7.5" fill={`url(#${gradientId})`} />

      {/* Bars lighten and shorten as they descend: that reads as depth without a shadow, and
          keeps the silhouette a stack rather than a hamburger menu — the failure mode when
          all three are the same width. */}
      <rect x="7" y="9" width="18" height="4" rx="2" fill="#FFFFFF" />
      <rect x="7" y="15" width="14" height="4" rx="2" fill="#BFDBFE" />
      <rect x="7" y="21" width="10" height="4" rx="2" fill="#7FA9F5" />
    </svg>
  )
}
