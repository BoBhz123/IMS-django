import { useEffect, useState } from 'react'
import { useCurrency } from '@/context/CurrencyContext'

/**
 * A price/cost input whose form state is ALWAYS USD, regardless of the active display
 * currency. When toggled to LBP, what the user types is divided by `rate` (or the global
 * default) before it ever reaches `onChangeUsd` — the backend only ever sees USD.
 */
export function CurrencyInput({ valueUsd, onChangeUsd, rate, placeholder, className = '' }) {
  const { currency, exchangeRate: globalRate } = useCurrency()
  // `rate` may arrive as a string mid-edit (e.g. the order/purchase form's own exchange-rate
  // field) — Number(...) here guards against an emptied field producing a divide-by-zero.
  const activeRate = Number(rate) || globalRate

  const toDisplay = (usd) => (currency === 'LBP' ? Math.round(usd * activeRate) : usd)
  // Round to cents — the backend's DecimalField (max_digits=7, decimal_places=2) rejects
  // anything more precise instead of rounding it itself (confirmed: it 400s, doesn't truncate).
  const fromDisplay = (display) => (currency === 'LBP' ? Math.round((display / activeRate) * 100) / 100 : display)

  const [text, setText] = useState(() => (valueUsd || valueUsd === 0 ? String(toDisplay(valueUsd)) : ''))

  // Re-sync the displayed text when the currency toggles — but not on every valueUsd change,
  // which would fight the user mid-keystroke (see fromDisplay rounding below).
  useEffect(() => {
    setText(valueUsd || valueUsd === 0 ? String(toDisplay(valueUsd)) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency])

  function handleChange(event) {
    const raw = event.target.value
    setText(raw)
    if (raw === '') {
      onChangeUsd(0)
      return
    }
    const parsed = parseFloat(raw)
    if (!Number.isNaN(parsed)) onChangeUsd(fromDisplay(parsed))
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2 focus-within:border-accent-blue/60 focus-within:ring-2 focus-within:ring-accent-blue/20 ${className}`}
    >
      <span className="shrink-0 text-[13px] text-text-tertiary">{currency === 'LBP' ? 'ل.ل' : '$'}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
      />
    </div>
  )
}
