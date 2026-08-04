import { motion } from 'framer-motion'

export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="relative flex rounded-xl bg-canvas-2 p-1 text-[12px] font-medium">
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`relative z-10 flex-1 rounded-lg px-3 py-1.5 transition-colors ${
              isActive ? 'text-white' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {isActive && (
              <motion.span
                layoutId="segmented-pill"
                className="absolute inset-0 -z-10 rounded-lg bg-accent-blue"
                transition={{ type: 'spring', stiffness: 500, damping: 34 }}
              />
            )}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
