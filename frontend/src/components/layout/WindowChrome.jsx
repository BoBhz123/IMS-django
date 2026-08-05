import { LogOut, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { useAuth } from '@/context/AuthContext'
import { useCurrency } from '@/context/CurrencyContext'

export function WindowChrome({ title }) {
  const { theme, toggleTheme } = useTheme()
  const { currency, toggleCurrency } = useCurrency()
  const { logout } = useAuth()

  return (
    <div className="flex items-center gap-4 border-b border-hairline px-6 py-3.5">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full bg-accent-red" />
        <span className="h-3 w-3 rounded-full bg-accent-orange" />
        <span className="h-3 w-3 rounded-full bg-accent-green" />
      </div>
      <span className="font-display text-[13px] font-medium text-text-secondary">{title}</span>

      <div className="ml-auto flex items-center gap-1 sm:hidden">
        <button
          type="button"
          onClick={toggleCurrency}
          aria-label={currency === 'USD' ? 'Show in LBP' : 'Show in USD'}
          className="touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
        >
          <span className="font-display text-[11px] font-bold">{currency === 'USD' ? '$' : 'ل.ل'}</span>
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          className="touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          onClick={logout}
          aria-label="Sign out"
          className="touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  )
}
