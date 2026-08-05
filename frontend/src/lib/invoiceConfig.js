// Issuer/sender identity printed on every invoice — this app has no per-tenant "company
// profile" model yet, so it's a single edit point here rather than a fake identity baked
// into the Invoice component itself. Edit these two values for your business.
export const INVOICE_SENDER_NAME = 'IMS Inventory Management'
export const INVOICE_SENDER_EMAIL = 'billing@yourcompany.com'
