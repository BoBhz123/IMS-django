import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Building2,
  LayoutDashboard,
  Moon,
  Package,
  Receipt,
  ShoppingCart,
  Sun,
  Tags,
  Truck,
  Users,
} from 'lucide-react'
import { CurrencyToggle } from '@/components/ui/CurrencyToggle'
import { DockButton, DockTooltip } from './DockButton'
import { useTheme } from '@/context/ThemeContext'
import { UserMenu } from './UserMenu'

export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/categories', label: 'Categories', icon: Tags },
  { to: '/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/purchases', label: 'Purchases', icon: Truck },
  { to: '/expenses', label: 'Expenses', icon: Receipt },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/suppliers', label: 'Suppliers', icon: Building2 },
]

function scaleFor(index, hoveredIndex) {
  if (hoveredIndex === null) return 1
  const distance = Math.abs(index - hoveredIndex)
  if (distance === 0) return 1.35
  if (distance === 1) return 1.14
  return 1
}

export function Dock() {
  const [hoveredIndex, setHoveredIndex] = useState(null)
  const { theme, toggleTheme } = useTheme()

  return (
    <nav
      className="fixed top-1/2 left-4 z-20 hidden -translate-y-1/2 flex-col items-center gap-1 rounded-squircle border border-glass-border bg-glass-strong px-2 py-3 backdrop-blur-2xl [box-shadow:var(--shadow-dock)] sm:flex"
      onMouseLeave={() => setHoveredIndex(null)}
      aria-label="Primary"
    >
      {NAV_ITEMS.map((item, index) => (
        <DockItem
          key={item.to}
          item={item}
          scale={scaleFor(index, hoveredIndex)}
          hovered={index === hoveredIndex}
          onHover={() => setHoveredIndex(index)}
        />
      ))}

      <div className="my-2 h-px w-6 bg-hairline" />

      {/* Renders nothing when the account is single-currency — the component owns that rule
          now, so the dock and the mobile header cannot disagree about it. */}
      <CurrencyToggle placement="right" />
      <DockButton label={theme === 'dark' ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}>
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </DockButton>
      <UserMenu placement="right" />
    </nav>
  )
}

export function MobileTabBar() {
  const { pathname } = useLocation()

  return (
    <nav
      className="safe-area-bottom fixed inset-x-3 bottom-3 z-20 flex items-center justify-between rounded-2xl border border-glass-border bg-glass-strong px-2 py-2 backdrop-blur-2xl [box-shadow:var(--shadow-dock)] sm:hidden"
      aria-label="Primary"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.end ? pathname === item.to : pathname.startsWith(item.to)
        const Icon = item.icon
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={`flex h-11 w-11 items-center justify-center rounded-xl ${
              isActive ? 'bg-accent-blue text-white' : 'text-text-secondary'
            }`}
            aria-label={item.label}
          >
            <Icon size={19} strokeWidth={2} />
          </NavLink>
        )
      })}
    </nav>
  )
}

function DockItem({ item, scale, hovered, onHover }) {
  const Icon = item.icon
  return (
    <NavLink to={item.to} end={item.end} className="group relative" onMouseEnter={onHover}>
      {({ isActive }) => (
        <>
          <motion.div
            animate={{ scale }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
              isActive ? 'bg-accent-blue text-white' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon size={19} strokeWidth={2} />
          </motion.div>
          {isActive && (
            <span className="absolute top-1/2 -left-2 h-1 w-1 -translate-y-1/2 rounded-full bg-accent-blue" />
          )}
          <DockTooltip visible={hovered}>{item.label}</DockTooltip>
        </>
      )}
    </NavLink>
  )
}
