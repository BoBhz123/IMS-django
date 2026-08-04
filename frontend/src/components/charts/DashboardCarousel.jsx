import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { RevenueTrendChart } from './RevenueTrendChart'

const SWIPE_THRESHOLD = 60

export function DashboardCarousel({ tabs }) {
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState(0)

  function goTo(nextIndex) {
    if (nextIndex < 0 || nextIndex >= tabs.length) return
    setDirection(nextIndex > index ? 1 : -1)
    setIndex(nextIndex)
  }

  function handleDragEnd(_, info) {
    if (info.offset.x < -SWIPE_THRESHOLD) goTo(index + 1)
    else if (info.offset.x > SWIPE_THRESHOLD) goTo(index - 1)
  }

  const active = tabs[index]

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-[14px] font-semibold text-text-primary">Revenue vs. cost</h2>
        <div className="w-56">
          <SegmentedControl
            options={tabs.map((tab) => ({ value: tab.key, label: tab.label }))}
            value={active.key}
            onChange={(key) => goTo(tabs.findIndex((tab) => tab.key === key))}
          />
        </div>
      </div>

      <div className="overflow-hidden">
        {/* popLayout (not "wait") so the incoming chart mounts and measures immediately instead of
            being gated behind the outgoing chart's exit animation — with "wait", any animation stall
            left the previous tab's stale data on screen indefinitely. */}
        <AnimatePresence mode="popLayout" custom={direction}>
          <motion.div
            key={active.key}
            custom={direction}
            initial={{ x: direction * 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: direction * -24, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.15}
            onDragEnd={handleDragEnd}
            className="cursor-grab active:cursor-grabbing"
          >
            {active.data.length > 0 ? (
              <RevenueTrendChart data={active.data} />
            ) : (
              <p className="py-16 text-center text-[13px] text-text-secondary">No activity in this period.</p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-3 flex justify-center gap-1.5">
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            aria-label={`Show ${tab.label}`}
            onClick={() => goTo(i)}
            className={`h-1.5 rounded-full transition-all ${
              i === index ? 'w-4 bg-accent-blue' : 'w-1.5 bg-text-tertiary/40'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
