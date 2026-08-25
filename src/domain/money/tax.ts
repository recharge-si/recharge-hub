/**
 * Converting a price between tax-inclusive and tax-exclusive (CLAUDE.md §8.6).
 *
 * This exists because two systems disagree about what a price *is*. Shopify
 * says whether its prices include tax with one shop-wide setting; a MetaKocka
 * pricelist has its own net-or-gross type, decided when the pricelist was
 * created. When those differ, writing the number across unchanged does not
 * produce a wrong format — it produces a wrong price, quietly, by exactly the
 * VAT rate, in an ERP that will accept it without a word.
 *
 * Integer minor units throughout (§15). The rounding is half-up on the final
 * unit, which is what every VAT authority expects and what MetaKocka itself
 * shows when it echoes a price back.
 */

/** "0.22" -> 0.22. Null, empty or nonsense means "no tax to apply". */
export function taxFactorToNumber(factor: string | null | undefined): number {
  if (!factor) return 0;
  const value = Number(String(factor).replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Gross to net: 209.00 at 22% is 171.31. */
export function grossToNetMinor(grossMinor: number, taxFactor: number): number {
  if (taxFactor <= 0) return grossMinor;
  return Math.round(grossMinor / (1 + taxFactor));
}

/** Net to gross: 171.31 at 22% is 209.00. */
export function netToGrossMinor(netMinor: number, taxFactor: number): number {
  if (taxFactor <= 0) return netMinor;
  return Math.round(netMinor * (1 + taxFactor));
}

export interface PriceBasisInput {
  /** The price as Shopify holds it, in minor units. */
  amountMinor: number;
  /** Whether that figure already includes tax. */
  sourceIncludesTax: boolean;
  /** Whether the destination wants a figure that includes tax. */
  targetIncludesTax: boolean;
  /** Decimal factor such as "0.22". */
  taxFactor: string | null;
}

export interface PriceBasisResult {
  amountMinor: number;
  /** True when a conversion actually happened. */
  converted: boolean;
  /**
   * Set when the two bases differ and there is no tax rate to convert with.
   * The caller must not send a price at all in that case: sending the
   * unconverted number would be wrong by the VAT rate.
   */
  impossible: boolean;
}

/**
 * Restates a price on the basis the destination expects.
 *
 * Returns `impossible` rather than guessing when the bases differ and no rate
 * is available. There is no safe fallback there — the unconverted number is
 * simply the wrong price — so it is the caller's job to stop and say so.
 */
export function toPriceBasis(input: PriceBasisInput): PriceBasisResult {
  if (input.sourceIncludesTax === input.targetIncludesTax) {
    return {
      amountMinor: input.amountMinor,
      converted: false,
      impossible: false,
    };
  }

  const factor = taxFactorToNumber(input.taxFactor);
  if (factor <= 0) {
    return {
      amountMinor: input.amountMinor,
      converted: false,
      impossible: true,
    };
  }

  return {
    amountMinor: input.targetIncludesTax
      ? netToGrossMinor(input.amountMinor, factor)
      : grossToNetMinor(input.amountMinor, factor),
    converted: true,
    impossible: false,
  };
}
