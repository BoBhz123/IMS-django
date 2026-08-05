import { createContext, useContext, useEffect, useState } from 'react'
import { api, tokenStore } from '@/lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState('loading') // loading | authenticated | anonymous

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (!tokenStore.getAccess()) {
        setStatus('anonymous')
        return
      }
      try {
        const { data } = await api.get('/auth/users/me/')
        if (!cancelled) {
          setUser(data)
          setStatus('authenticated')
        }
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
    const { data: me } = await api.get('/auth/users/me/')
    setUser(me)
    setStatus('authenticated')
  }

  async function logout() {
    const refresh = tokenStore.getRefresh()
    tokenStore.clear()
    setUser(null)
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
    <AuthContext.Provider value={{ user, status, login, logout }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
