import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import type { CanonicalLine } from "~/domain/orders/canonical";
import {
  describeDiscrepancies,
  verifyPaymentRepresentation,
  verifyQuantities,
  verifyValue,
  type QuantityVerification,
  type ValueVerification,
} from "~/domain/orders/invariants";

/**
 * Checking that a reconciliation actually reconciled (CLAUDE.md §8.11;
 * order-reconciliation brief §25, §26).
 *
 * The rules that produce a correct MetaKocka state are enforced in several
 * places and each of them can be wrong. This asks the question directly
 * afterwards, of the result rather than of the process: does what the ERP holds
 * for this order add up to what Shopify says the customer is buying?
 *
 * **What "what the ERP holds" means here.** It is read from the recorded
 * request bodies — the exact documents MetaKocka accepted — not from a fresh
 * read of every document on every pass. Two reasons, and the second is the
 * important one: a read per document per reconciliation is several MetaKocka
 * calls for an order nobody has touched (§2.5, §3), and the question "does
 * MetaKocka still say what we sent" is a *different* question, already asked
 * hourly by the drift poller. This one is "does what we sent add up", which is
 * the failure the poller cannot see — every individual document can be exactly
 * as sent while the set of them describes twice the order.
 *
 * Retired documents are counted. That is the point of counting them: a document
 * the order no longer takes anything from, which MetaKocka refused to empty,
 * is holding quantity that has to show up somewhere.
 */

const productLineSchema = z.object({
  code: z.string().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  price_with_tax: z.union([z.string(), z.number()]).optional(),
  price: z.union([z.string(), z.number()]).optional(),
});

const documentBodySchema = z.object({
  product_list: z.array(productLineSchema).default([]),
});

export interface RecordedDocument {
  countCode: string;
  retired: boolean;
  /** The body MetaKocka accepted, as recorded. */
  requestBody: unknown;
}

export interface DocumentContent {
  countCode: string;
  retired: boolean;
  lines: { sku: string; quantity: number }[];
  /** Line value only, tax-inclusive as sent. Shipping is not a line (T-05). */
  valueMinor: number;
}

/**
 * Reads back what a recorded document says it holds.
 *
 * A body that will not parse contributes nothing rather than throwing. That is
 * deliberate and it is the conservative direction: an unparseable body makes
 * the *actual* total look smaller, which reports a shortfall — a condition that
 * asks a human to look — where the alternative, skipping the whole check, would
 * report everything as fine.
 */
export function contentOf(document: RecordedDocument): DocumentContent {
  const parsed = documentBodySchema.safeParse(document.requestBody);

  if (!parsed.success) {
    return {
      countCode: document.countCode,
      retired: document.retired,
      lines: [],
      valueMinor: 0,
    };
  }

  const lines: { sku: string; quantity: number }[] = [];
  let valueMinor = 0;

  for (const line of parsed.data.product_list) {
    const sku = line.code ?? "";
    const quantity = Number(line.amount ?? 0);
    if (!Number.isFinite(quantity) || quantity === 0) continue;

    lines.push({ sku, quantity });

    const unit = line.price_with_tax ?? line.price;
    if (unit !== undefined) {
      valueMinor += toMinorUnits(unit) * quantity;
    }
  }

  return {
    countCode: document.countCode,
    retired: document.retired,
    lines,
    valueMinor,
  };
}

export interface VerificationResult {
  ok: boolean;
  quantities: QuantityVerification;
  value: ValueVerification;
  payments: ReturnType<typeof verifyPaymentRepresentation>;
  /** Merchant-readable, one line per SKU that does not add up. */
  summary: string[];
  /** Which documents were counted, so the audit trail can be re-derived. */
  documents: {
    countCode: string;
    retired: boolean;
    quantity: number;
    valueMinor: number;
  }[];
}

export function verifyOrder(input: {
  lines: CanonicalLine[];
  documents: RecordedDocument[];
  orderTotalMinor: number;
  /**
   * Money the connector knows is not on any document line.
   *
   * Shipping and the order-level discount are accounted for in the payment
   * shares but are not yet encoded as MetaKocka lines (project status
   * T-05/T-06). Passing them keeps the value check honest — it still fails when
   * a line price drifts, which is what it is for — instead of failing for a
   * limitation that is recorded elsewhere and has its own fix.
   */
  unrepresentedMinor: number;
  grossReceivedMinor: number;
  representedPaymentMinor: number;
}): VerificationResult {
  const contents = input.documents.map(contentOf);

  const quantities = verifyQuantities({
    expected: input.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
    })),
    actual: contents.flatMap((document) => document.lines),
  });

  const value = verifyValue({
    expectedMinor: input.orderTotalMinor,
    actualMinor: contents.reduce(
      (total, document) => total + document.valueMinor,
      0,
    ),
    allowanceMinor: input.unrepresentedMinor,
  });

  const payments = verifyPaymentRepresentation({
    grossReceivedMinor: input.grossReceivedMinor,
    representedMinor: input.representedPaymentMinor,
  });

  const summary = [
    ...describeDiscrepancies(quantities.discrepancies),
    ...(value.ok
      ? []
      : [
          `Value: Shopify ${decimal(value.expectedMinor)}, MetaKocka ${decimal(value.actualMinor)} (${value.differenceMinor > 0 ? "+" : ""}${decimal(value.differenceMinor)}).`,
        ]),
  ];

  return {
    // Payments deliberately do not fail the order's *sync* verdict. A payment
    // waiting on an unmapped gateway is a blocked payment, which has its own
    // exception and its own retry; calling the whole order inconsistent for it
    // would put a red banner on an order whose documents are perfect.
    ok: quantities.ok && value.ok,
    quantities,
    value,
    payments,
    summary,
    documents: contents.map((document) => ({
      countCode: document.countCode,
      retired: document.retired,
      quantity: document.lines.reduce(
        (total, line) => total + line.quantity,
        0,
      ),
      valueMinor: document.valueMinor,
    })),
  };
}

/** Minor units as a plain decimal string, for a sentence. Integer maths (§15). */
function decimal(minor: number, decimals = 2): string {
  const negative = minor < 0;
  const digits = Math.abs(Math.trunc(minor))
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction =
    decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
