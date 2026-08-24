import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.jsx'
import { ThemeProvider } from '@/context/ThemeContext'
import { AuthProvider } from '@/context/AuthContext'
import { CurrencyProvider } from '@/context/CurrencyContext'

// No-op with no VITE_SENTRY_DSN set (local dev, or before it's provisioned in production) —
// same "only if present" pattern as the backend's SENTRY_DSN in ims/settings.py.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Matches the backend's 10% — a conventional production default, not full sampling
    // (expensive/noisy at scale) or none (no signal).
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* CurrencyProvider sits INSIDE AuthProvider: the currency settings belong to the signed-in
        account, so the provider has to know whether anyone is signed in and re-read them when
        that changes. It used to wrap AuthProvider, back when the display currency was a purely
        local toggle kept in localStorage. */}
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <CurrencyProvider>
            <App />
          </CurrencyProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
