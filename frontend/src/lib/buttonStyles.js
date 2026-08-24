/**
 * One vocabulary for button priority, so the same action does not look primary on one screen and
 * incidental on the next.
 *
 * Class strings rather than a <Button> component: the call sites are <button>, <a>, and
 * framer-motion elements, and a wrapper would have to re-expose the full prop surface of all
 * three. A string composes with `className` and gets out of the way.
 *
 *   btnPrimary    the one action the screen exists for — Add order, Save changes
 *   btnSecondary  a real action, but not the point of the screen — Export, Show filters
 *   btnGhost      low-weight, repeated per row — View, Edit, Invoice
 *   btnIcon       a square icon-only control — pagination, close
 *
 * `focus-visible` rather than `focus`: a mouse click should not leave a ring behind, but a
 * keyboard user must never lose track of where they are.
 */

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium transition-all duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 ' +
  'disabled:pointer-events-none disabled:opacity-50'

export const btnPrimary =
  `${base} rounded-xl bg-accent-blue px-3.5 py-2 text-[13px] font-semibold text-white ` +
  'shadow-sm hover:brightness-110 active:scale-[0.97]'

export const btnSecondary =
  `${base} rounded-xl border border-hairline bg-canvas-2/70 px-3.5 py-2 text-[13px] ` +
  'text-text-primary hover:border-accent-blue/40 hover:bg-canvas-2 active:scale-[0.97]'

export const btnGhost =
  `${base} rounded-lg px-2 py-1 text-[12px] text-text-secondary ` +
  'hover:bg-canvas-2 hover:text-text-primary active:scale-[0.97]'

export const btnIcon =
  `${base} h-8 w-8 rounded-lg border border-hairline text-text-secondary ` +
  'hover:bg-canvas-2 hover:text-text-primary active:scale-[0.95]'

/** Ghost, but tinted for the action a row is most likely to want. */
export const btnGhostAccent =
  `${base} rounded-lg px-2 py-1 text-[12px] text-accent-blue ` +
  'hover:bg-accent-blue/10 active:scale-[0.97]'
