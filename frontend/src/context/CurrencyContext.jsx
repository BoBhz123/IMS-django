import { createContext, useContext, useEffect, useState } from 'react'
import { formatLBP, formatMoney } from '@/lib/format'

const CurrencyContext = createContext(null)

export const DEFAULT_EXCHANGE_RATE = 89000

export function CurrencyProvider({ children }) {
  const [currency, setCurrency] = useState(() => localStorage.getItem('ims.currency') || 'USD')

  useEffect(() => {
    localStorage.setItem('ims.currency', currency)
  }, [currency])

  const toggleCurrency = () => setCurrency((c) => (c === 'USD' ? 'LBP' : 'USD'))

  // rate is optional per-call so callers with a real transaction rate (Orders/Purchases) can
  // use it instead of the global default (Products/Dashboard have no per-item rate to fall back on).
  function formatAmount(usdAmount, rate = DEFAULT_EXCHANGE_RATE, options = {}) {
    return currency === 'LBP' ? formatLBP(usdAmount, rate, options) : formatMoney(usdAmount, options)
  }

  return (
    <CurrencyContext.Provider
      value={{ currency, exchangeRate: DEFAULT_EXCHANGE_RATE, toggleCurrency, formatAmount }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (!context) throw new Error('useCurrency must be used within a CurrencyProvider')
  return context
}
