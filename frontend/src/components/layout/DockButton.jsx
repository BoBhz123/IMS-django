import { useState } from 'react'

/**
 * The dock rail's own button chrome: a 40px squircle with a tooltip that slides out to the
 * right on hover.
 *
 * Lives in its own module rather than inside Dock.jsx because CurrencyToggle needs it too, and
 * Dock.jsx imports CurrencyToggle — importing it back from there would be a cycle. Anything
 * else that lands in the rail should come through here as well, so the rail's controls stay
 * one size and one hover treatment.
 *
 * `ariaLabel` exists because the tooltip and the accessible name are not always the same
 * sentence. A tooltip is read beside a control the user can already see, so it only has to
 * carry the *action* ("Switch to Lebanese Pound"); an accessible name has to carry the current
 * state as well, since a screen-reader user never sees the glyph. When they are the same
 * string — every nav item, the theme button — pass `label` alone.
 */
export function DockButton({ label, ariaLabel, onClick, children }) {
  const [isHovered, setIsHovered] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group relative flex h-10 w-10 items-center justify-center rounded-2xl text-text-secondary transition-colors hover:bg-canvas-2 hover:text-text-primary"
      aria-label={ariaLabel ?? label}
    >
      {children}
      <DockTooltip visible={isHovered}>{label}</DockTooltip>
    </button>
  )
}

export function DockTooltip({ visible, children }) {
  return (
    <span
      className={`pointer-events-none absolute top-1/2 left-full ml-3 -translate-y-1/2 rounded-lg border border-glass-border bg-glass-strong px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-text-primary backdrop-blur-xl transition-all duration-150 [box-shadow:var(--shadow-glass)] ${
        visible ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
      }`}
    >
      {children}
    </span>
  )
}
