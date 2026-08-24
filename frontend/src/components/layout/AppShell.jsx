import { Outlet, useLocation } from 'react-router-dom'
import { Dock, MobileTabBar, NAV_ITEMS } from './Dock'
import { TrialBanner } from './TrialBanner'
import { WindowChrome } from './WindowChrome'

export function AppShell() {
  const { pathname } = useLocation()
  const activeItem = NAV_ITEMS.find((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))

  return (
    // overflow-x-hidden, not overflow-hidden: the ambient blobs must not produce a horizontal
    // scrollbar, but clipping the vertical axis here would also clip anything a page floats
    // above its own content. See the window card below.
    <div className="safe-area-top relative min-h-screen overflow-x-hidden bg-canvas print:hidden">
      <AmbientBackground />
      <Dock />
      <MobileTabBar />

      <div className="px-3 py-4 pb-24 sm:px-6 sm:py-6 sm:pb-6 sm:pl-28 lg:pl-32">
        <TrialBanner />
        {/*
          This card must NOT be overflow-hidden.

          Every page renders inside it, so an overflow-hidden here clips anything a page floats
          outside its normal flow — which sliced the filter popover off at the card's bottom
          border whenever the table underneath was shorter than the open panel. It was there to
          keep square corners off the rounded card, but nothing inside paints its own
          background: WindowChrome is a border-bottom over the card's own `bg-glass`, and the
          content wrapper is unstyled. Border-radius already clips the card's own background and
          border painting, so there is nothing left for overflow-hidden to do here except break
          popovers.
        */}
        <div className="mx-auto max-w-6xl rounded-squircle border border-glass-border bg-glass backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
          <WindowChrome title={activeItem?.label ?? 'IMS'} />
          <div className="p-4 sm:p-6">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  )
}

function AmbientBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-accent-blue/20 blur-[120px]" />
      <div className="absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-accent-purple/15 blur-[120px]" />
      <div className="absolute -bottom-40 left-1/3 h-96 w-96 rounded-full bg-accent-teal/15 blur-[120px]" />
    </div>
  )
}
