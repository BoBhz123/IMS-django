import { api } from '@/lib/api'

/**
 * Resolve a scanned code to a product.
 *
 * Uses ?barcode= (exact) rather than ?search= (icontains over name, description and
 * barcode): a scanner submits a complete code, and a fuzzy match would silently add the
 * wrong product to an order.
 *
 * Several matches are reported as ambiguous rather than resolved by guessing. Barcodes are
 * now unique per account, so this should not occur — it is kept as the safe response to the
 * database saying otherwise (a bulk import, or the constraint being dropped), because the
 * alternative is silently adding whichever product the API happened to return first.
 *
 * `error` is kept distinct from `not_found` on purpose: not_found should invite the user to
 * add the product, error should invite them to retry. Collapsing the two sends people off
 * creating duplicates whenever the network drops.
 */
export async function lookupByBarcode(code) {
  try {
    const { data } = await api.get('/inventory/products/', { params: { barcode: code } })
    const products = data.results ?? []
    if (products.length === 0) return { status: 'not_found', products }
    if (products.length > 1) return { status: 'ambiguous', products }
    return { status: 'found', products }
  } catch {
    return { status: 'error', products: [] }
  }
}
