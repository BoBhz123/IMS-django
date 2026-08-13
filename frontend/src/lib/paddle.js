/**
 * Paddle.js, loaded on demand.
 *
 * Not imported as a package and not in index.html: the script is only needed by people who
 * actually reach the plan screen and choose to pay by card, and pulling a third-party script
 * into every page load costs the other 99% of sessions for nothing. Loading it here also
 * means a customer paying by Whish or cash never talks to Paddle at all.
 */

const SCRIPT_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js'

let loadPromise = null

/** Resolves with `window.Paddle`. Concurrent calls share one script tag. */
export function loadPaddle() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.Paddle) return Promise.resolve(window.Paddle)
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_URL}"]`)
    const script = existing ?? document.createElement('script')

    script.addEventListener('load', () => {
      if (window.Paddle) resolve(window.Paddle)
      else reject(new Error('Paddle.js loaded but did not initialise'))
    })
    script.addEventListener('error', () => {
      // Cleared so a later attempt can retry — an ad blocker or a flaky network on the
      // first click should not permanently disable card payment for the session.
      loadPromise = null
      reject(new Error('Could not load Paddle.js'))
    })

    if (!existing) {
      script.src = SCRIPT_URL
      script.async = true
      document.head.appendChild(script)
    }
  })

  return loadPromise
}

/**
 * Open the hosted overlay for a checkout the *server* described.
 *
 * Every field here came from POST /billing/checkout/. Nothing about the price is computed or
 * chosen in the browser: the server picked the price id, and there is deliberately no amount
 * or currency to tamper with — see the USD-only rule in CLAUDE.md.
 */
export async function openPaddleCheckout(checkout, { email } = {}) {
  const paddle = await loadPaddle()

  paddle.Environment?.set?.(checkout.environment === 'production' ? 'production' : 'sandbox')
  paddle.Initialize({ token: checkout.client_token })

  paddle.Checkout.open({
    items: [{ priceId: checkout.price_id, quantity: 1 }],
    // Comes back on the webhook, which is the only thing that grants access. The redirect
    // the customer lands on afterwards is decoration and is never trusted.
    customData: checkout.custom_data,
    customer: email ? { email } : undefined,
    settings: { displayMode: 'overlay', theme: 'light' },
  })
}
