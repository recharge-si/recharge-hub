import { z } from "zod";

import { toMinorUnits } from "~/adapters/metakocka/values";
import type {
  CanonicalLine,
  QuantityClassification,
} from "~/domain/orders/canonical";
import {
  describeDiscrepancies,
  describeValueReconciliation,
  reconcileValue,
  verifyPaymentRepresentation,
  verifyQuantities,
  type QuantityVerification,
  type ValueReconciliation,
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
  /** Managed / external / unresolved, carried through for the audit trail. */
  classification: QuantityClassification;
  value: ValueReconciliation;
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
  /**
   * Where every Shopify quantity went (`domain/orders/canonical`).
   *
   * The expected side of the quantity invariant is the **managed** quantity,
   * not the raw Shopify quantity, because a unit Shopify is shipping through a
   * third-party service is deliberately not in MetaKocka. Comparing against
   * the raw figure would report that as a shortfall for ever.
   *
   * What stops that becoming a hole is `unresolvedTotal`: any quantity nothing
   * can place fails verification on its own, whatever the documents say. So an
   * order can only pass by having every unit either represented or explicitly
   * external — never by having one quietly fall out of the allocation.
   */
  classification: QuantityClassification;
  documents: RecordedDocument[];
  orderTotalMinor: number;
  /**
   * The parts of the order's money that are deliberately not document lines.
   *
   * Named individually rather than summed into an allowance, because an
   * allowance is a way of not checking: any drift smaller than the postage
   * would pass, whatever caused it. `reconcileValue` closes the identity
   * instead, so shipping is explained *as shipping* and anything left over
   * fails.
   */
  shippingMinor: number;
  orderDiscountMinor: number;
  grossReceivedMinor: number;
  representedPaymentMinor: number;
}): VerificationResult {
  const contents = input.documents.map(contentOf);

  const quantities = verifyQuantities({
    expected: input.classification.lines
      .filter((line) => line.managed > 0)
      .map((line) => ({ sku: line.sku, quantity: line.managed })),
    actual: contents.flatMap((document) => document.lines),
  });

  /*
   * What the documents should be worth, from the same managed quantities the
   * quantity invariant uses — not from the order total. Deriving it from the
   * total would make the two checks the same check written twice.
   */
  const unitPrice = new Map(
    input.lines.map((line) => [line.shopifyLineItemId, line] as const),
  );

  let productsExpectedMinor = 0;
  let externalValueMinor = 0;
  let lineDiscountMinor = 0;

  for (const line of input.classification.lines) {
    const source = unitPrice.get(line.shopifyLineItemId);
    if (!source) continue;
    productsExpectedMinor += line.managed * source.unitPriceWithTaxMinor;
    externalValueMinor += line.external * source.unitPriceWithTaxMinor;
    // Stored per line and deliberately not encoded on the document line
    // (project status T-06). Named here so it explains rather than hides.
    lineDiscountMinor += source.discountMinor;
  }

  const value = reconcileValue({
    orderTotalMinor: input.orderTotalMinor,
    documentsMinor: contents.reduce(
      (total, document) => total + document.valueMinor,
      0,
    ),
    productsExpectedMinor,
    lineDiscountMinor,
    orderDiscountMinor: input.orderDiscountMinor,
    shippingMinor: input.shippingMinor,
    externalValueMinor,
  });

  const payments = verifyPaymentRepresentation({
    grossReceivedMinor: input.grossReceivedMinor,
    representedMinor: input.representedPaymentMinor,
  });

  const summary = [
    ...describeDiscrepancies(quantities.discrepancies),
    ...(input.classification.unresolvedTotal > 0
      ? [
          `${input.classification.unresolvedTotal} ${input.classification.unresolvedTotal === 1 ? "unit is" : "units are"} not accounted for anywhere: ${input.classification.unresolvedLines
            .map((line) => `${line.sku || line.title} (${line.unresolved})`)
            .join(", ")}.`,
        ]
      : []),
    ...(input.classification.externalTotal > 0
      ? [
          `${input.classification.externalTotal} ${input.classification.externalTotal === 1 ? "unit is" : "units are"} fulfilled outside MetaKocka and deliberately not represented there.`,
        ]
      : []),
    ...(value.ok ? [] : describeValueReconciliation(value, decimal)),
  ];

  return {
    /*
     * Payments deliberately do not fail the order's *sync* verdict. A payment
     * waiting on an unmapped gateway is a blocked payment, which has its own
     * exception and its own retry; calling the whole order inconsistent for it
     * would put a red banner on an order whose documents are perfect.
     *
     * Unresolved quantity **does** fail it, and that is the point of tracking
     * it: an order with a unit nothing can place must never report clean, even
     * when every document that exists is perfectly correct.
     */
    ok: quantities.ok && value.ok && input.classification.unresolvedTotal === 0,
    quantities,
    classification: input.classification,
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
