import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AuthContext } from '@/context/AuthContext'
import { api } from '@/lib/api'
import { formatLBP, formatMoney } from '@/lib/format'

const CurrencyContext = createContext(null)

export const DEFAULT_EXCHANGE_RATE = 89000

/** What the app assumes before the account's real settings have loaded (or when signed out). */
const DEFAULT_SETTINGS = {
  primaryCurrency: 'USD',
  enableDualCurrency: true,
  secondaryCurrency: 'LBP',
}

const otherCurrency = (code) => (code === 'USD' ? 'LBP' : 'USD')

/**
 * Display currency for the whole app.
 *
 * **Nothing here changes a stored value.** Every amount in this application is persisted in USD
 * — `cost_price`, `unit_price`, `unit_cost_price`, `Expense.amount` — and profit, COGS and
 * analytics are all computed from those. These settings choose how those USD figures are
 * *rendered*, which is why switching to LBP needs no migration and is reversible.
 *
 * Two independent things:
 *   `primaryCurrency`    the account's base operating currency — what it reads by default.
 *   `enableDualCurrency` whether the *other* currency is shown alongside it at all.
 *
 * With dual display off the app is strictly single-currency: no secondary equivalents, no
 * conversion lines, and the manual toggle disappears rather than silently doing nothing.
 */
export function CurrencyProvider({ children }) {
  // useContext rather than useAuth(): this provider is mounted inside AuthProvider in the real
  // app, but component tests render consumers without it. A null context means "not signed in",
  // which is exactly the right behaviour — fall back to defaults and fetch nothing.
  const auth = useContext(AuthContext)
  const isAuthenticated = auth?.status === 'authenticated'

  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  // The currency actually on screen. Starts at the primary and follows it whenever the account
  // settings change; the manual toggle moves it to the secondary while dual display is on.
  const [currency, setCurrency] = useState(DEFAULT_SETTINGS.primaryCurrency)

  useEffect(() => {
    if (!isAuthenticated) {
      setSettings(DEFAULT_SETTINGS)
      setCurrency(DEFAULT_SETTINGS.primaryCurrency)
      return
    }
    let cancelled = false
    api
      .get('/accounts/currency-settings/')
      .then(({ data }) => {
        if (cancelled) return
        const next = {
          primaryCurrency: data.primary_currency,
          enableDualCurrency: data.enable_dual_currency,
          secondaryCurrency: data.secondary_currency,
        }
        setSettings(next)
        setCurrency(next.primaryCurrency)
      })
      // Deliberately silent. A failed settings fetch must not toast on every page load or block
      // the app — the USD defaults above are a working fallback, and every stored amount is USD
      // anyway, so the worst case is that the display preference is not applied.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const toggleCurrency = useCallback(() => {
    // A no-op with dual display off. The toggle is hidden in that mode too (see Dock and
    // WindowChrome), but guarding here as well means a stray call cannot put the app into a
    // currency the account said it does not use.
    setSettings((current) => {
      if (!current.enableDualCurrency) return current
      setCurrency((shown) => otherCurrency(shown))
      return current
    })
  }, [])

  const updateSettings = useCallback(async (patch) => {
    const { data } = await api.patch('/accounts/currency-settings/', patch)
    const next = {
      primaryCurrency: data.primary_currency,
      enableDualCurrency: data.enable_dual_currency,
      secondaryCurrency: data.secondary_currency,
    }
    setSettings(next)
    // Snap back to the primary: leaving the screen showing a secondary currency that was just
    // switched off would be the one state the settings say cannot exist.
    setCurrency(next.primaryCurrency)
    return next
  }, [])

  const value = useMemo(() => {
    const format = (code, usdAmount, rate, options) =>
      code === 'LBP'
        ? formatLBP(usdAmount, rate || DEFAULT_EXCHANGE_RATE, options)
        : formatMoney(usdAmount, options)

    return {
      ...settings,
      currency,
      exchangeRate: DEFAULT_EXCHANGE_RATE,
      toggleCurrency,
      updateSettings,

      /** The amount in whichever currency is currently on screen. */
      formatAmount: (usdAmount, rate = DEFAULT_EXCHANGE_RATE, options = {}) =>
        format(currency, usdAmount, rate, options),

      /**
       * The same amount in the *other* currency, or null when dual display is off.
       * Callers render the conversion line only when this returns a string, which is what
       * makes "hide every secondary total" a single rule rather than a flag checked in
       * fifteen components.
       */
      formatSecondary: (usdAmount, rate = DEFAULT_EXCHANGE_RATE, options = {}) => {
        if (!settings.enableDualCurrency) return null
        return format(otherCurrency(currency), usdAmount, rate, options)
      },

      /**
       * Whether a per-transaction exchange-rate input should be shown.
       *
       * Not simply `enableDualCurrency`. With dual display off *and* USD primary there is no
       * conversion anywhere and the field is pure noise — hide it. But with LBP primary the
       * rate is what turns the stored USD into every number on screen, so hiding it would
       * remove the user's control over all of them. It is the operating rate then, not a
       * secondary-currency detail.
       */
      showExchangeRate: settings.enableDualCurrency || settings.primaryCurrency === 'LBP',
    }
  }, [settings, currency, toggleCurrency, updateSettings])

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
}

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (!context) throw new Error('useCurrency must be used within a CurrencyProvider')
  return context
}
