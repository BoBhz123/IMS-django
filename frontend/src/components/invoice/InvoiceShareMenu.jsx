import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ExternalLink, Send, Share2 } from 'lucide-react'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'

/**
 * One "Share" control standing in for the row of per-target send buttons.
 *
 * WhatsApp and Telegram were two buttons onto one OS share sheet, sitting beside Print and
 * Download in a five-control bar. Collapsing the two targets behind a menu keeps the bar to
 * the two things that always work — print and download — plus one way to send.
 *
 * It registers through useOverlayLayer rather than binding a bare Escape listener, because
 * this menu opens *inside* the invoice Modal. An unconditional listener would close the
 * invoice underneath it on the same keypress — the exact regression lib/overlayStack.js
 * exists to prevent. `lockScroll: false` for the same reason FilterPopover passes it: an
 * anchored menu that dims nothing must not freeze the document behind it, and a layer that
 * never acquired the lock must not release one.
 */
export function InvoiceShareMenu({ onWhatsApp, onTelegram, shareUrl = null, onShare = null, sharing = false }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)
  const { isTop } = useOverlayLayer(open, { lockScroll: false })

  /**
   * Minting the public link happens when the menu opens, not when a target is pressed.
   *
   * That timing is the whole trick. `window.open` called after an `await` is treated as a
   * popup rather than a navigation and is blocked by default, so the token has to already
   * exist by the time the WhatsApp item is clicked — and it does, because opening the menu
   * and choosing a target are two separate gestures with a human pause between them.
   *
   * The endpoint is idempotent: re-sharing an already-shared order returns the same token
   * rather than minting a fresh one, so reopening the menu costs a request and changes
   * nothing. That is what makes "ensure" the right word for this.
   */
  useEffect(() => {
    if (!open || shareUrl || sharing || !onShare) return
    onShare()
    // onShare is an inline arrow at the call site, so a new identity every render — including
    // the render its own setSharing(true) causes. Depending on it would re-fire the mint in a
    // loop; `open` is the edge that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return undefined

    function handleKeyDown(event) {
      if (event.key !== 'Escape' || !isTop()) return
      setOpen(false)
      // Or Escape strands a keyboard user with nothing focused inside a still-open invoice.
      triggerRef.current?.focus()
    }
    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open, isTop])

  /**
   * Runs the send, then closes.
   *
   * Order matters: the send has to happen on this click's own call stack, because
   * navigator.share is refused outside a user gesture. Closing first is still synchronous
   * today, but doing the work first makes the constraint unmissable to the next reader.
   */
  function send(action) {
    action()
    setOpen(false)
  }

  // An invoice that can have a public link, whose link has not arrived yet.
  const pendingLink = Boolean(onShare) && !shareUrl

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-xl bg-accent-blue/10 px-3 py-1.5 text-[13px] font-semibold text-accent-blue hover:bg-accent-blue/15"
      >
        <Share2 size={14} />
        Share
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Share invoice"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            // right-0: the action bar is right-aligned, so a left-anchored panel would grow
            // off the edge of the invoice on a narrow sheet.
            className="absolute right-0 z-50 mt-2 w-56 origin-top-right overflow-hidden rounded-squircle-sm border border-glass-border bg-glass-strong py-1.5 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]"
          >
            {/* Disabled only while the link is actually in flight, and only where a link is
                expected at all: a purchase invoice passes no onShare, and its message is
                sendable immediately without one. Sending mid-mint would compose a message
                with the link missing — the one thing the recipient needs. */}
            <ShareItem
              icon={Share2}
              tint="#25D366"
              onClick={() => send(onWhatsApp)}
              disabled={pendingLink}
            >
              {pendingLink ? 'Preparing link…' : 'WhatsApp'}
            </ShareItem>
            <ShareItem
              icon={Send}
              tint="#229ED9"
              onClick={() => send(onTelegram)}
              disabled={pendingLink}
            >
              {pendingLink ? 'Preparing link…' : 'Telegram'}
            </ShareItem>

            {shareUrl && <div className="my-1.5 h-px bg-hairline" />}

            {/* The link the message carries, so the sender can see and check what they are
                about to publish. There is no "create" item any more — the token is minted on
                open. */}
            {shareUrl && (
              <a
                role="menuitem"
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-canvas-2"
              >
                <ExternalLink size={15} />
                Open public link
              </a>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A row in the menu. The role and the handler are on the same element deliberately — a
 *  role on a wrapper with the handler on a child is a control that does nothing when
 *  activated by role, which is how screen readers and tests reach it. */
function ShareItem({ icon: Icon, tint, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-text-primary transition-colors hover:bg-canvas-2 disabled:opacity-60"
    >
      <Icon size={15} color={tint} />
      {children}
    </button>
  )
}
