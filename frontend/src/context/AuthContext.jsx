import { createContext, useContext, useEffect, useState } from 'react'
import { api, tokenStore } from '@/lib/api'

// Exported so a consumer that must tolerate having no session — useSellerIdentity, which
// renders an invoice's letterhead — can read it with useContext and fall back, rather than
// going through useAuth, which throws outside a provider.
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [account, setAccount] = useState(null)
  const [status, setStatus] = useState('loading') // loading | authenticated | anonymous

  // Both calls are needed before the app can render: the router decides which onboarding
  // screen to show from the account's subscription status, so fetching it lazily would flash
  // the dashboard at an unpaid account.
  async function loadSession() {
    const [{ data: me }, { data: accountData }] = await Promise.all([
      api.get('/auth/users/me/'),
      api.get('/accounts/subscription/'),
    ])
    setUser(me)
    setAccount(accountData)
    setStatus('authenticated')
    return accountData
  }

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (!tokenStore.getAccess()) {
        setStatus('anonymous')
        return
      }
      try {
        await loadSession()
      } catch {
        if (!cancelled) {
          tokenStore.clear()
          setStatus('anonymous')
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  async function login(username, password) {
    const { data } = await api.post('/auth/jwt/create/', { username, password })
    tokenStore.set(data.access, data.refresh)
    await loadSession()
  }

  async function register({ email, password, phone, businessName }) {
    await api.post('/auth/users/', {
      email,
      password,
      phone,
      business_name: businessName,
    })
    // The email is the username: AUTH_USER_MODEL was not swapped, so simplejwt still
    // authenticates against the username column.
    await login(email, password)
  }

  /**
   * Throw away an unverified sign-up and return to anonymous.
   *
   * Local state is cleared whatever the server says. The row may already be gone — the
   * session can lapse and be discarded by the verify or resend endpoint between renders —
   * and holding on to a token for a deleted user would leave the router bouncing the person
   * back to a verification screen for an account that no longer exists.
   *
   * No /auth/jwt/blacklist/ call, unlike logout: the user row is deleted, which cascades its
   * outstanding tokens, so there is nothing left to blacklist and the request would only 401.
   */
  async function abandonRegistration() {
    try {
      await api.post('/accounts/abandon-registration/')
    } catch {
      // Already discarded, or the session lapsed first. Either way the outcome we want has
      // happened, and the local clear below is what the user actually sees.
    }
    tokenStore.clear()
    setUser(null)
    setAccount(null)
    setStatus('anonymous')
  }

  async function refreshAccount() {
    const { data } = await api.get('/accounts/subscription/')
    setAccount(data)
    return data
  }

  async function logout() {
    const refresh = tokenStore.getRefresh()
    tokenStore.clear()
    setUser(null)
    setAccount(null)
    setStatus('anonymous')

    if (refresh) {
      try {
        await api.post('/auth/jwt/blacklist/', { refresh })
      } catch {
        // Token may already be expired/rotated — logout has already cleared local state either way.
      }
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        account,
        status,
        login,
        register,
        refreshAccount,
        abandonRegistration,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
