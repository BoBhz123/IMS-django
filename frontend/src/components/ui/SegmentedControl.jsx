import { useId } from 'react'
import { motion } from 'framer-motion'

/**
 * A row of mutually exclusive choices with the selected one under a sliding pill.
 *
 * The pill's `layoutId` defaults to one generated per instance. It used to be the constant
 * "segmented-pill", which is a shared identity: framer-motion treats two elements with the same
 * layoutId as the same element moving, so with two controls mounted at once the pill flies across
 * the screen from one to the other. That is reachable on the dashboard today (the period selector
 * and the carousel's own control), and adding the payment selector to the order and purchase
 * forms would put a third on screen over the top of them.
 */
export function SegmentedControl({ options, value, onChange, layoutId }) {
  const generatedId = useId()
  const pillId = layoutId ?? `segmented-pill-${generatedId}`

  return (
    <div className="relative flex rounded-xl bg-canvas-2 p-1 text-[12px] font-medium">
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={isActive}
            className={`relative z-10 flex-1 rounded-lg px-3 py-1.5 transition-colors ${
              isActive ? 'text-white' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {isActive && (
              <motion.span
                layoutId={pillId}
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
