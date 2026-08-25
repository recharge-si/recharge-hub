/**
 * Human labels for Shopify's payment gateway handles.
 *
 * Shopify sends a handle, not a name: `shopify_payments`, `cash_on_delivery`.
 * The handle is what gets stored and matched, so it stays visible under the
 * label — a merchant reconciling against Shopify's own reporting needs the exact
 * string, and a label alone would leave them guessing which row is which.
 *
 * An unknown handle falls back to itself. New gateways appear all the time and
 * an honest raw handle is better than a wrong friendly name.
 */
const LABELS: Record<string, string> = {
  bank_deposit: "Bank deposit",
  cash_on_delivery: "Cash on delivery",
  shopify_payments: "Shopify Payments",
  paypal: "PayPal",
  gift_card: "Gift card",
  "exchange-credit": "Exchange credit",
  manual: "Manual",
};

export function gatewayLabel(handle: string): string {
  return LABELS[handle] ?? handle;
}
