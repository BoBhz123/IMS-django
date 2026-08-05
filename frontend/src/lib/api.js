import axios from 'axios'
import { toast } from './toast'

// No VITE_API_BASE_URL override -> derive it from wherever the page was actually loaded
// from, not a value baked into the JS bundle at build time. This matters a lot in the
// multi-tenant deployment: the SAME built bundle is served from every *.myimsapp.com
// subdomain (django-tenants resolves the tenant from the request's Host header), so a
// hardcoded API origin would send every tenant's frontend to the SAME backend schema
// regardless of which subdomain the browser is actually on — which is exactly the bug
// this was rewritten to fix (see docs/superpowers/specs, "cross-tenant data leakage").
//
// import.meta.env.DEV is true only under `vite dev`, never in a production build: the dev
// server runs on a different port (5173) than the Django API (8000), so it needs the
// explicit :8000 suffix; a production build is same-origin (frontend and API served by the
// same Heroku app/domain), so window.location.origin is already correct as-is.
const baseURL =
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:8000`
    : window.location.origin)

export const api = axios.create({ baseURL })

const ACCESS_KEY = 'ims.access'
const REFRESH_KEY = 'ims.refresh'

export const tokenStore = {
  getAccess: () => localStorage.getItem(ACCESS_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  set: (access, refresh) => {
    localStorage.setItem(ACCESS_KEY, access)
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
  },
}

api.interceptors.request.use((config) => {
  const access = tokenStore.getAccess()
  if (access) config.headers.Authorization = `JWT ${access}`
  return config
})

/** Turns a Django/DRF error response into one human-readable line for a toast. */
function messageFor(error) {
  const { response } = error
  if (!response) return 'Network error — check your connection and try again.'

  const { status, data } = response
  // Blob responses (file exports) can't be inspected here — data is a Blob, not JSON.
  const body = data instanceof Blob ? null : data

  if (status === 400) {
    if (typeof body?.detail === 'string') return body.detail
    const firstField = body && typeof body === 'object' ? Object.keys(body)[0] : null
    const firstMessage = firstField && Array.isArray(body[firstField]) ? body[firstField][0] : null
    if (firstField && firstMessage) return `${firstField}: ${firstMessage}`
    return 'There was a problem with your request. Please check your input and try again.'
  }
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return "You don't have permission to do that."
  if (status === 404) return 'That resource could not be found.'
  if (status >= 500) return 'Server error — please try again in a moment.'
  return typeof body?.detail === 'string' ? body.detail : 'Something went wrong. Please try again.'
}

function notifyError(error) {
  toast.error(messageFor(error))
}

let refreshPromise = null

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Requests we cancelled ourselves (e.g. an AbortController on unmount) aren't user-facing failures — don't toast them.
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
      throw error
    }

    const { config, response } = error
    // The login/refresh endpoints show their own inline errors (see Login.jsx) — don't also toast them.
    const isAuthEndpoint = config?.url?.includes('/auth/jwt/')

    if (response?.status !== 401 || config._retried || isAuthEndpoint) {
      if (!isAuthEndpoint) notifyError(error)
      throw error
    }
    config._retried = true

    const refresh = tokenStore.getRefresh()
    if (!refresh) {
      tokenStore.clear()
      notifyError(error)
      throw error
    }

    refreshPromise ??= api
      .post('/auth/jwt/refresh/', { refresh })
      .then(({ data }) => {
        tokenStore.set(data.access, refresh)
        return data.access
      })
      .catch((refreshError) => {
        tokenStore.clear()
        notifyError(error)
        throw refreshError
      })
      .finally(() => {
        refreshPromise = null
      })

    const access = await refreshPromise
    config.headers.Authorization = `JWT ${access}`
    return api(config)
  },
)
