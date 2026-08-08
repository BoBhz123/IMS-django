import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { routeForAccountStatus } from '@/lib/onboarding'

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
  // app shell would just fill the screen with failed requests and error toasts.
  const onboardingRoute = routeForAccountStatus(account?.status ?? null)
  if (onboardingRoute) {
    return <Navigate to={onboardingRoute} replace />
  }

  return <Outlet />
}
