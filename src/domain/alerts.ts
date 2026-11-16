/**
 * Operator alerts: which exceptions are worth a message outside the app, and
 * what the message says (docs/architecture.md § Operator alerts).
 *
 * The Needs attention page is where every exception lives. This is for the few
 * that mean the integration itself has stopped doing its job — an order that
 * never reached the ERP, background work that gave up, stock that stopped
 * moving, an ERP that does not add up — where waiting for somebody to open the
 * app is waiting too long.
 *
 * **No customer data and no secrets, by construction.** The message is built
 * from the kind, the shop's domain and the Shopify order number only. The
 * exception's own message and detail are deliberately never read here: they
 * can quote what MetaKocka answered, which can include a name or an address.
 */

export const ALERT_KINDS = [
  "order_not_transferred",
  "job_failed",
  "stock_sync_failed",
  "sync_inconsistent",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export function isAlertKind(kind: string): kind is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(kind);
}

const LABEL: Record<AlertKind, string> = {
  order_not_transferred: "Order not in MetaKocka",
  job_failed: "Background work stopped",
  stock_sync_failed: "Stock not syncing",
  sync_inconsistent: "MetaKocka does not add up",
};

export interface AlertSubject {
  kind: AlertKind;
  shopDomain: string;
  /** Shopify's order number ("#1006" or "1006"), when the exception is about one. */
  orderNumber: string | null;
  /** The queue a dead job came from, which names work rather than a person. */
  queue: string | null;
  /** Where to look: the order page, or Needs attention. */
  link: string;
}

/**
 * Where an alert points: the order inside the Shopify admin, or the app's
 * Needs attention page for a condition that is not about one order.
 *
 * `admin.shopify.com/store/<handle>/apps/<api key>/…` opens the embedded app
 * at that path, signed in the way the merchant already is.
 */
export function alertLink(input: {
  shopDomain: string;
  apiKey: string;
  orderId: string | null;
}): string {
  const handle = input.shopDomain.replace(/\.myshopify\.com$/, "");
  const path = input.orderId
    ? `app/orders/${encodeURIComponent(input.orderId)}`
    : "app/exceptions";
  return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/apps/${encodeURIComponent(input.apiKey)}/${path}`;
}

/** Slack mrkdwn, one line. Angle brackets and ampersands escaped as Slack asks. */
export function formatAlert(subject: AlertSubject): string {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const order = subject.orderNumber
    ? ` order ${subject.orderNumber.startsWith("#") ? "" : "#"}${subject.orderNumber}`
    : "";
  const queue = subject.queue ? ` (${subject.queue})` : "";
  return `*${LABEL[subject.kind]}*: ${escape(subject.shopDomain)}${escape(order)}${escape(queue)} · \`${subject.kind}\` · <${subject.link}|Open in Recharge Hub>`;
}
