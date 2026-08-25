import { Moon, Sun } from 'lucide-react'
import { CurrencyToggle } from '@/components/ui/CurrencyToggle'
import { useTheme } from '@/context/ThemeContext'
import { UserMenu } from './UserMenu'

export function WindowChrome({ title }) {
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="flex items-center gap-4 border-b border-hairline px-6 py-3.5">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full bg-accent-red" />
        <span className="h-3 w-3 rounded-full bg-accent-orange" />
        <span className="h-3 w-3 rounded-full bg-accent-green" />
      </div>
      <span className="font-display text-[13px] font-medium text-text-secondary">{title}</span>

      <div className="ml-auto flex items-center gap-1 sm:hidden">
        {/* Renders nothing with dual display off — the account operates in one currency, so a
            control that switches to another is offering something that does not exist. That
            rule lives in the component, shared with the dock. */}
        <CurrencyToggle placement="bottom" />
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          className="touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <UserMenu placement="bottom" />
      </div>
    </div>
  )
}
