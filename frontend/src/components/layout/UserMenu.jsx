import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, Settings as SettingsIcon, User } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'

/**
 * The account menu that replaced the bare Sign out button.
 *
 * Sign out sat one mis-tap away from the theme toggle in both the dock and the mobile
 * chrome. Putting it behind a menu costs a deliberate second tap, which is the right price
 * for the only irreversible control in the shell.
 *
 * `placement` picks which way the panel opens: the dock is a vertical rail on the left, the
 * mobile chrome is a horizontal bar at the top right.
 */
export function UserMenu({ placement = 'right' }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const buttonRef = useRef(null)
  const { user, account, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Focus goes back to the trigger, or Escape strands a keyboard user at the top of the
      // document with nothing focused.
      buttonRef.current?.focus()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const email = account?.email || user?.email || ''
  const label = account?.business_name || email || 'Account'

  function go(path) {
    setOpen(false)
    navigate(path)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={
          placement === 'right'
            ? 'flex h-10 w-10 items-center justify-center rounded-2xl text-text-secondary transition-colors hover:bg-canvas-2 hover:text-text-primary'
            : 'touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary'
        }
      >
        <Avatar label={label} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={`absolute z-30 w-56 overflow-hidden rounded-2xl border border-glass-border bg-glass-strong py-1.5 backdrop-blur-2xl [box-shadow:var(--shadow-glass)] ${
            placement === 'right'
              ? 'bottom-0 left-full ml-3'
              : 'top-full right-0 mt-2'
          }`}
        >
          <div className="border-b border-hairline px-3 pb-2 pt-1">
            <p className="truncate text-[13px] font-medium text-text-primary">{label}</p>
            {email && label !== email && (
              <p className="truncate text-[12px] text-text-secondary">{email}</p>
            )}
          </div>

          <MenuItem icon={SettingsIcon} onClick={() => go('/settings')}>
            Account Settings
          </MenuItem>
          <MenuItem icon={LogOut} onClick={logout} destructive>
            Sign Out
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon: Icon, onClick, children, destructive = false }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium transition-colors hover:bg-canvas-2 ${
        destructive ? 'text-accent-red' : 'text-text-primary'
      }`}
    >
      <Icon size={15} />
      {children}
    </button>
  )
}

function Avatar({ label }) {
  const initials = String(label)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()

  if (!initials) return <User size={18} />

  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-blue/15 font-display text-[11px] font-bold text-accent-blue"
    >
      {initials}
    </span>
  )
}
