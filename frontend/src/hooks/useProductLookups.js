import { useEffect, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'

/**
 * Categories and suppliers for the product form, for callers that do not already hold them.
 *
 * Products.jsx fetches both once and passes them down. The order and purchase forms do not —
 * they render ProductForm as a quick-create and have no reason to know about either list. That
 * is what used to crash the quick-create outright: ProductFormBody spreads its `categories`
 * prop, and spreading `undefined` throws.
 *
 * Defaulting the prop to `[]` would not have been a fix. The category select is `required`, so
 * an empty list produces a form that can never be submitted — the quick-create has to obtain
 * real data, not merely survive the render.
 *
 * `enabled` gates on the form's `open` prop so a closed SlideOver does not fetch two lists it
 * may never show.
 */
export function useProductLookups(enabled = true) {
  const [lookups, setLookups] = useState({ categories: [], suppliers: [] })

  useEffect(() => {
    if (!enabled) return undefined

    const controller = new AbortController()
    // Failures are swallowed, matching Products.jsx: an empty select is a degraded form, but an
    // unhandled rejection here would take down the transaction form this is nested inside.
    api
      .get('/inventory/categories/', { signal: controller.signal })
      .then(({ data }) => setLookups((prev) => ({ ...prev, categories: data })))
      .catch((error) => {
        if (!axios.isCancel(error)) setLookups((prev) => prev)
      })
    api
      .get('/inventory/suppliers/', { signal: controller.signal })
      .then(({ data }) => setLookups((prev) => ({ ...prev, suppliers: data })))
      .catch((error) => {
        if (!axios.isCancel(error)) setLookups((prev) => prev)
      })

    return () => controller.abort()
  }, [enabled])

  return lookups
}
