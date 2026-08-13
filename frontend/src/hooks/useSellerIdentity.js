import { useContext } from 'react'
import { AuthContext } from '@/context/AuthContext'
import {
  INVOICE_FALLBACK_EMAIL, INVOICE_FALLBACK_NAME, INVOICE_FALLBACK_PHONE,
} from '@/lib/invoiceConfig'

/**
 * The business details printed at the top of an invoice.
 *
 * Read from the account rather than a hardcoded config so a real invoice carries the real
 * seller: `business_name`, `phone` and `email` already travel on the subscription payload
 * (accounts.serializers.subscription_payload), so this needs no new endpoint.
 *
 * `useContext` directly, not `useAuth()`: useAuth throws outside an AuthProvider, and the
 * invoice must still render — with the fallbacks — in a unit test or any tree that has no
 * session. A missing letterhead is not worth a crashed print dialog.
 */
export function useSellerIdentity() {
  const account = useContext(AuthContext)?.account

  return {
    name: account?.business_name?.trim() || INVOICE_FALLBACK_NAME,
    phone: account?.phone?.trim() || INVOICE_FALLBACK_PHONE,
    email: account?.email?.trim() || INVOICE_FALLBACK_EMAIL,
  }
}
