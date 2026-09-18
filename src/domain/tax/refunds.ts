import { rateKeyToPpm } from "~/domain/tax/rates";
import type {
  LineTaxDecision,
  RateKey,
  TaxDecision,
  TaxSource,
  TaxTreatment,
} from "~/domain/tax/types";

/**
 * A refund reverses the tax the order was filed with — never the tax today's
 * configuration would compute (§33 of the brief).
 *
 * The order's `TaxDecision` is the record of what each line was taxed at and
 * why. A refund six months later reads that record: the rate, the treatment
 * and the registration context come from it, and only the *amounts* come from
 * the refund itself. Where Shopify states the refunded tax on a line it is
 * used, because it is the transaction; where it does not, the line's share is
 * taken from the snapshot in proportion to the quantity returned.
 *
 * Nothing here writes a credit note. MetaKocka's credit-note behaviour is not
 * verified (docs/project-status.md), so this produces the breakdown a person
 * needs to issue one — per rate and per treatment — and the exception carries
 * it.
 */

export interface RefundLineInput {
  lineId: string;
  quantity: number;
  /** What Shopify refunded for the line, on the order's price basis. Null when unstated. */
  subtotalMinor: number | null;
  /** The tax Shopify refunded on the line. Null when unstated. */
  taxMinor: number | null;
}

export interface RefundInput {
  refundId: string;
  createdAt: string | null;
  totalRefundedMinor: number;
  lines: RefundLineInput[];
  /** Shipping refunded, and the tax on it where Shopify stated it. */
  shipping: { amountMinor: number; taxMinor: number | null } | null;
}

export interface RefundTaxEntry {
  lineId: string;
  sku: string;
  quantity: number;
  rateKey: RateKey | null;
  treatment: TaxTreatment;
  source: TaxSource;
  taxableMinor: number;
  taxMinor: number;
  /** Whether the amounts are Shopify's own or a proportional share of the snapshot. */
  basis: "shopify" | "snapshot";
}

export interface RefundTaxTotal {
  rateKey: RateKey | null;
  treatment: TaxTreatment;
  taxableMinor: number;
  taxMinor: number;
}

export interface RefundTaxBreakdown {
  refundId: string;
  createdAt: string | null;
  /** The configuration the *order* was decided under, not today's. */
  configVersion: number;
  currency: string;
  entries: RefundTaxEntry[];
  shipping: RefundTaxEntry | null;
  /** Grouped by rate and treatment: what a credit note is issued per. */
  totals: RefundTaxTotal[];
  totalTaxableMinor: number;
  totalTaxMinor: number;
  /** Refund lines the snapshot has no decision for. Reported, never guessed at. */
  unmatchedLineIds: string[];
}

/** `amount × part / whole`, rounded half up, in integers. */
function share(amount: number, part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  const numerator = BigInt(amount) * BigInt(part);
  const denominator = BigInt(whole);
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const rounded = (n % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return Number(negative ? -rounded : rounded);
}

function entryFor(
  decision: TaxDecision,
  line: LineTaxDecision,
  quantityOnOrder: number,
  refund: { quantity: number; subtotalMinor: number | null; taxMinor: number | null },
): RefundTaxEntry {
  const shopifyStated = refund.subtotalMinor !== null && refund.taxMinor !== null;

  let taxableMinor: number;
  let taxMinor: number;

  if (shopifyStated) {
    taxMinor = refund.taxMinor!;
    taxableMinor = decision.taxesIncluded
      ? refund.subtotalMinor! - taxMinor
      : refund.subtotalMinor!;
  } else {
    taxableMinor = share(line.taxableMinor, refund.quantity, quantityOnOrder);
    taxMinor = share(line.taxMinor, refund.quantity, quantityOnOrder);
  }

  return {
    lineId: line.lineId,
    sku: line.sku,
    quantity: refund.quantity,
    rateKey: line.rateKey,
    treatment: line.treatment,
    source: line.source,
    taxableMinor,
    taxMinor,
    basis: shopifyStated ? "shopify" : "snapshot",
  };
}

export function reverseTaxForRefund(
  decision: TaxDecision,
  quantities: Map<string, number>,
  refund: RefundInput,
): RefundTaxBreakdown {
  const byLine = new Map(decision.lines.map((line) => [line.lineId, line]));
  const entries: RefundTaxEntry[] = [];
  const unmatchedLineIds: string[] = [];

  for (const refunded of refund.lines) {
    const line = byLine.get(refunded.lineId);
    if (!line) {
      unmatchedLineIds.push(refunded.lineId);
      continue;
    }
    entries.push(
      entryFor(decision, line, quantities.get(refunded.lineId) ?? refunded.quantity, refunded),
    );
  }

  let shipping: RefundTaxEntry | null = null;
  if (refund.shipping && refund.shipping.amountMinor > 0) {
    const template = decision.shipping;
    if (template) {
      const taxMinor =
        refund.shipping.taxMinor ??
        (template.taxableMinor + template.taxMinor > 0
          ? share(
              template.taxMinor,
              refund.shipping.amountMinor,
              template.taxableMinor + template.taxMinor,
            )
          : 0);
      shipping = {
        lineId: "shipping",
        sku: "",
        quantity: 1,
        rateKey: template.rateKey,
        treatment: template.treatment,
        source: template.source,
        taxableMinor: decision.taxesIncluded
          ? refund.shipping.amountMinor - taxMinor
          : refund.shipping.amountMinor,
        taxMinor,
        basis: refund.shipping.taxMinor !== null ? "shopify" : "snapshot",
      };
    } else {
      unmatchedLineIds.push("shipping");
    }
  }

  const all = shipping ? [...entries, shipping] : entries;
  const totals = new Map<string, RefundTaxTotal>();
  for (const entry of all) {
    const key = `${entry.rateKey ?? "?"}|${entry.treatment}`;
    const current = totals.get(key) ?? {
      rateKey: entry.rateKey,
      treatment: entry.treatment,
      taxableMinor: 0,
      taxMinor: 0,
    };
    current.taxableMinor += entry.taxableMinor;
    current.taxMinor += entry.taxMinor;
    totals.set(key, current);
  }

  return {
    refundId: refund.refundId,
    createdAt: refund.createdAt,
    configVersion: decision.configVersion,
    currency: decision.currency,
    entries,
    shipping,
    totals: [...totals.values()].sort(
      (a, b) => (rateKeyToPpm(a.rateKey ?? "0") ?? 0) - (rateKeyToPpm(b.rateKey ?? "0") ?? 0),
    ),
    totalTaxableMinor: all.reduce((sum, entry) => sum + entry.taxableMinor, 0),
    totalTaxMinor: all.reduce((sum, entry) => sum + entry.taxMinor, 0),
    unmatchedLineIds,
  };
}
