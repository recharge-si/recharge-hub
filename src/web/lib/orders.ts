/**
 * What an order's two statuses are called, and when they are allowed a colour.
 *
 * Both the list and the detail page state these, and before this file they
 * stated them differently: the detail page printed the raw enum, so a merchant
 * read "partially_paid". One table, one vocabulary.
 *
 * Tone is sparing, so the one broken row in a list has something to stand out
 * against: an order moving normally through the pipeline stays neutral however
 * far it has got. The exception is a settled payment, which is green on the
 * merchant's request — it is the one fact on the row they scan for.
 */
export type Tone = "critical" | "warning" | "success" | "neutral";

export interface StatusCopy {
  label: string;
  tone: Tone;
}

/** Where the order has got to in this app (`OrderStatus`). */
const PROGRESS: Record<string, StatusCopy> = {
  received: { label: "Not sent", tone: "neutral" },
  allocated: { label: "Allocated", tone: "neutral" },
  written: { label: "Sent", tone: "neutral" },
  needs_attention: { label: "Needs attention", tone: "critical" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function describeProgress(status: string): StatusCopy {
  return PROGRESS[status] ?? { label: status, tone: "neutral" };
}

/**
 * Shopify's `financial_status` (CLAUDE.md section 8.7).
 *
 * The two that carry a colour are the two section 8.7 turns into exceptions
 * rather than acting on: a partial payment is not split across documents by
 * guesswork, and a voided order never auto-deletes what MetaKocka already holds.
 */
const PAYMENT: Record<string, StatusCopy> = {
  pending: { label: "Payment pending", tone: "neutral" },
  authorized: { label: "Authorised", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  partially_paid: { label: "Partially paid", tone: "warning" },
  refunded: { label: "Refunded", tone: "neutral" },
  partially_refunded: { label: "Partially refunded", tone: "neutral" },
  voided: { label: "Voided", tone: "critical" },
  unknown: { label: "Payment unknown", tone: "neutral" },
};

export function describePayment(status: string): StatusCopy {
  return PAYMENT[status] ?? { label: status, tone: "neutral" };
}

/** The status filter above the list, in pipeline order. */
export const PROGRESS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All orders" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "received", label: "Not sent" },
  { value: "allocated", label: "Allocated" },
  { value: "written", label: "Sent" },
  { value: "cancelled", label: "Cancelled" },
];

export function isProgressFilter(value: string): boolean {
  return PROGRESS_FILTERS.some(
    (option) => option.value !== "" && option.value === value,
  );
}

/**
 * A tax factor as the rate a merchant knows.
 *
 * `"0.22"` is what goes to MetaKocka (§3: `tax_factor` is a decimal); 22% is
 * what appears on the invoice and in the merchant's head. The decimal place
 * only shows when it carries something — 9.5% keeps it, 22% does not gain
 * "22.0%".
 *
 * Null means Shopify never said, which is a different statement from zero and
 * is the difference between a legitimate exempt line and an order this app
 * refuses to guess at (§11).
 */
export function formatTaxRate(taxFactor: string | null): string {
  if (taxFactor === null) return "—";

  const rate = Number(taxFactor);
  if (!Number.isFinite(rate)) return "—";

  const percent = rate * 100;
  return `${percent.toFixed(Number.isInteger(percent) ? 0 : 1)}%`;
}
