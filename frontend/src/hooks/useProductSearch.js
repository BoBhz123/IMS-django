import { useEffect, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'

/**
 * Debounced product search for line-item pickers (order/purchase forms).
 * Empty query returns the first page of the default-ordered catalog.
 */
export function useProductSearch(query, enabled = true) {
  const [products, setProducts] = useState([])
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle')

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    const timeout = setTimeout(async () => {
      setStatus('loading')
      try {
        const { data } = await api.get('/inventory/products/', {
          params: query ? { search: query } : {},
          signal: controller.signal,
        })
        setProducts(data.results)
        setStatus('ready')
      } catch (error) {
        if (!axios.isCancel(error)) setStatus('error')
      }
    }, 350)

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [query, enabled])

  return { products, status }
}
