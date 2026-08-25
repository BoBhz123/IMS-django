import { useCurrency } from '@/context/CurrencyContext'

const CURRENCY_LABELS = {
  USD: { symbol: '$', name: 'US Dollar' },
  LBP: { symbol: 'ل.ل', name: 'Lebanese Pound' },
}

const describe = (code) => CURRENCY_LABELS[code]?.name ?? code

/**
 * The display-currency switch in the app chrome. One press, one flip.
 *
 * Shared by the dock (desktop) and the window header (mobile) so the two surfaces cannot drift
 * on what the control does, what it is called, or when it appears.
 *
 * It shows the **currency code**, not just a symbol. The button it replaces rendered a bare
 * "$" or "ل.ل", which asks the user to recognise a glyph and then guess whether it means "you
 * are in dollars" or "press for dollars" — the two readings are opposites, and nothing on
 * screen settled it. A three-letter code with the symbol beside it states the current mode
 * outright, and the accessible name carries the part a label cannot: what pressing it will do.
 *
 * Display only. Every amount in this app is stored in USD (see CurrencyContext); this changes
 * how those figures are rendered and writes nothing. The account's *base* currency is a
 * different setting, changed in Settings.
 *
 * Renders nothing when dual display is off: the account is strictly single-currency then, so a
 * switch would be offering something that does not exist.
 */
export function CurrencyToggle({ placement = 'right' }) {
  const { currency, primaryCurrency, secondaryCurrency, enableDualCurrency, toggleCurrency } =
    useCurrency()

  if (!enableDualCurrency) return null

  const { symbol } = CURRENCY_LABELS[currency] ?? { symbol: currency }
  // The one it will switch to. Derived from the account's own pair rather than assuming
  // USD/LBP, so an account whose base is LBP describes the swap the right way round.
  const other = currency === primaryCurrency ? secondaryCurrency : primaryCurrency

  return (
    <button
      type="button"
      onClick={toggleCurrency}
      // Names the state *and* the outcome. The old label said only "Show in LBP", which reads
      // as the current mode to anyone who meets it without seeing the glyph.
      aria-label={`Currency: ${describe(currency)}. Switch to ${describe(other)}.`}
      title={`Switch to ${describe(other)}`}
      className={
        placement === 'right'
          ? 'flex h-10 w-10 flex-col items-center justify-center gap-0 rounded-2xl text-text-secondary transition-colors hover:bg-canvas-2 hover:text-text-primary'
          : 'touch-target flex items-center justify-center gap-1 rounded-lg px-2 text-text-secondary transition-colors hover:bg-canvas-2 hover:text-text-primary'
      }
    >
      <span aria-hidden="true" className="font-display text-[12px] leading-none font-bold">
        {symbol}
      </span>
      <span
        aria-hidden="true"
        className={
          placement === 'right'
            ? 'font-display text-[9px] leading-tight font-semibold tracking-wide'
            : 'font-display text-[11px] leading-none font-semibold tracking-wide'
        }
      >
        {currency}
      </span>
    </button>
  )
}
