import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { routeForAccount } from '@/lib/onboarding'

export function ProtectedRoute() {
  const { status, account } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-hairline border-t-accent-blue" />
      </div>
    )
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // An un-onboarded account authenticates fine but the API 403s everything, so rendering the
  // app shell would just fill the screen with failed requests and error toasts. The pathname
  // is passed so the unpaid whitelist (/subscription, /settings) can exempt itself — without
  // it, an expired account is bounced off /settings and cannot read its own account id.
  const onboardingRoute = routeForAccount(account, location.pathname)
  if (onboardingRoute) {
    return <Navigate to={onboardingRoute} replace />
  }

  return <Outlet />
}
