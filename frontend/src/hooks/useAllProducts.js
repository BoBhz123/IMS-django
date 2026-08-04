import { useEffect, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'

/**
 * ProductViewSet is paginated (10/page) — page through it once for form pickers that need the full catalog.
 * Pass `enabled=false` (e.g. a closed SlideOver's `open` prop) to skip fetching until the picker is actually shown —
 * otherwise this pages through every product on mount, even while hidden.
 */
export function useAllProducts(enabled = true) {
  const [products, setProducts] = useState([])
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle')

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()

    async function load() {
      setStatus('loading')
      try {
        let url = '/inventory/products/'
        let all = []
        while (url) {
          const { data } = await api.get(url, { signal: controller.signal })
          all = all.concat(data.results)
          url = data.next
        }
        setProducts(all)
        setStatus('ready')
      } catch (error) {
        if (!axios.isCancel(error)) setStatus('error')
      }
    }

    load()
    return () => {
      controller.abort()
    }
  }, [enabled])

  return { products, status }
}
