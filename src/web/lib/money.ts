/**
 * Money for display only.
 *
 * Everything internal is integer minor units (CLAUDE.md section 15) and stays
 * that way right up to the screen. This is the one place that turns those into
 * something a person reads, and it never converts a currency: section 8.6 says
 * the presentment currency and amount are what the customer was charged, and
 * quietly showing shop currency instead would misstate the order.
 */
export function formatMoney(
  minor: number,
  currency: string,
  decimals = 2,
): string {
  const amount = minor / 10 ** decimals;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // An unknown currency code should still show the number rather than throw.
    return `${amount.toFixed(decimals)} ${currency}`;
  }
}
