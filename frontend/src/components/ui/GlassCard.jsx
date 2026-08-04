import { motion } from 'framer-motion'

export function GlassCard({ as: Component = motion.div, className = '', children, ...props }) {
  return (
    <Component
      className={`rounded-squircle border border-glass-border bg-glass backdrop-blur-2xl [box-shadow:var(--shadow-glass)] ${className}`}
      {...props}
    >
      {children}
    </Component>
  )
}
