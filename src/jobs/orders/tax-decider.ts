import type { ExceptionKind } from "@prisma/client";

import {
  closeExceptionsFor,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import {
  getTaxConfig,
  getTaxSnapshot,
  recordRefundBreakdowns,
  saveTaxDecision,
  type StoredTaxSnapshot,
} from "~/adapters/db/repositories/tax.server";
import { getLogger } from "~/adapters/observability/logger.server";
import type { ParsedOrder } from "~/adapters/shopify/order-payload";
import { decideOrderTax } from "~/domain/tax/decide";
import { reverseTaxForRefund, type RefundTaxBreakdown } from "~/domain/tax/refunds";
import type { TaxConfig, TaxDecision, TaxIssueKind } from "~/domain/tax/types";
import type { Principal } from "~/domain/types";

/**
 * The tax decision, in the reconciliation loop (§10–§17, §41–§45 of the brief).
 *
 * One place decides every order's VAT, and it sits between "what Shopify says
 * the order is" and "what MetaKocka should hold": the reconciler calls it
 * after the lines are current and before any document is planned, and the
 * write job reads the stored result rather than deciding anything itself.
 *
 * **Which configuration decides.** The current one, until a document has been
 * written under a decision — from then on the snapshot is history, and an
 * edit to that order is re-decided under the configuration frozen in it. A
 * mapping added last week must not silently re-tax a document the ERP already
 * holds; a person retiring or rewriting that document is a different action.
 * A blocked snapshot (nothing sent) is always re-decided under the current
 * configuration, because the merchant fixing the configuration is exactly how
 * it gets unblocked.
 *
 * **Refunds** are reversed against the decision on every pass and appended to
 * the snapshot keyed by refund id, so a re-read never counts one twice.
 */

/** The exception kind each blocking issue is filed under. */
export const EXCEPTION_KIND_FOR_ISSUE: Record<TaxIssueKind, ExceptionKind | null> = {
  mapping_missing: "tax_mapping_missing",
  treatment_unknown: "tax_treatment_unknown",
  destination_missing: "tax_treatment_unknown",
  data_insufficient: "tax_data_insufficient",
  reconciliation_failed: "tax_reconciliation_failed",
  registration_error: "vat_registration_configuration_error",
  // Informational: the order page and diagnostics show it, no exception.
  rate_mismatch: null,
};

export const TAX_EXCEPTION_KINDS: ExceptionKind[] = [
  "tax_mapping_missing",
  "tax_treatment_unknown",
  "tax_data_insufficient",
  "tax_reconciliation_failed",
  "vat_registration_configuration_error",
  // The pre-engine kind, still raised by the MetaKocka error classifier.
  "tax_undeterminable",
];

export interface TaxDecisionOutcome {
  decision: TaxDecision;
  config: TaxConfig;
  /** Whether the decision was made under a frozen, historical configuration. */
  historical: boolean;
  /** Every refund Shopify reports, reversed against this decision. */
  refunds: RefundTaxBreakdown[];
}

/** Which configuration an order is decided under. */
function configFor(
  snapshot: StoredTaxSnapshot | null,
  current: TaxConfig,
): { config: TaxConfig; historical: boolean } {
  if (snapshot?.frozenAt && snapshot.decision.ok) {
    return { config: snapshot.config, historical: true };
  }
  return { config: current, historical: false };
}

/**
 * Decides the order's tax and records it. Pure decision, one write.
 *
 * Raises nothing: the caller decides whether the shop is transferring orders
 * at all before an exception is worth a merchant's attention
 * (`applyTaxExceptions`).
 */
export async function decideOrderTaxFor(
  principal: Principal,
  input: { orderId: string; parsed: ParsedOrder; now: Date },
): Promise<TaxDecisionOutcome> {
  const { orderId, parsed, now } = input;
  const log = getLogger();

  const [snapshot, current] = await Promise.all([
    getTaxSnapshot(principal, orderId),
    getTaxConfig(principal),
  ]);
  const { config, historical } = configFor(snapshot, current);

  const decision = decideOrderTax(parsed.tax, config);
  await saveTaxDecision(principal, { orderId, decision, config, now });

  const quantities = new Map(
    parsed.lines.map((line) => [line.shopifyLineItemId, line.quantity]),
  );
  const refunds = parsed.refunds.map((refund) =>
    reverseTaxForRefund(decision, quantities, refund),
  );
  if (refunds.length > 0) {
    await recordRefundBreakdowns(principal, orderId, refunds);
  }

  log.info(
    {
      shop: principal.shopDomain,
      orderId,
      configVersion: config.version,
      historical,
      destination: decision.destinationCountry,
      jurisdiction: decision.jurisdiction,
      customerKind: decision.customerKind,
      treatment: decision.treatment,
      source: decision.source,
      rateKeys: decision.rateKeys,
      taxMinor: decision.totals.taxMinor,
      shopifyTaxMinor: decision.totals.shopifyTaxMinor,
      reconciled: decision.totals.reconciled,
      ok: decision.ok,
      issues: decision.issues.map((issue) => `${issue.severity}:${issue.kind}`),
      lines: decision.lines.map((line) => ({
        lineId: line.lineId,
        sku: line.sku,
        rateKey: line.rateKey,
        treatment: line.treatment,
        source: line.source,
        taxFactor: line.metakockaTaxFactor,
        mapping: line.mapping,
      })),
    },
    decision.ok ? "Order tax decided" : "Order tax could not be decided",
  );

  return { decision, config, historical, refunds };
}

/**
 * Files the blocking issues as exceptions, one per kind, and closes the kinds
 * that no longer apply. Each message is the engine's own — it names the line,
 * the rate and the page — so the queue reads as instructions.
 */
export async function applyTaxExceptions(
  principal: Principal,
  input: { orderId: string; orderNumber: string; decision: TaxDecision },
): Promise<void> {
  const { orderId, orderNumber, decision } = input;

  const byKind = new Map<ExceptionKind, string[]>();
  for (const issue of decision.issues) {
    if (issue.severity !== "blocking") continue;
    const kind = EXCEPTION_KIND_FOR_ISSUE[issue.kind];
    if (!kind) continue;
    const messages = byKind.get(kind) ?? [];
    messages.push(issue.message);
    byKind.set(kind, messages);
  }

  for (const [kind, messages] of byKind) {
    await raiseException(principal, {
      orderId,
      kind,
      message: `Order ${orderNumber} was not sent to MetaKocka because its VAT could not be filed safely. ${messages.join(" ")}`,
      detail: {
        configVersion: decision.configVersion,
        destinationCountry: decision.destinationCountry,
        jurisdiction: decision.jurisdiction,
        treatment: decision.treatment,
        rateKeys: decision.rateKeys,
        issues: decision.issues
          .filter((issue) => issue.severity === "blocking" && EXCEPTION_KIND_FOR_ISSUE[issue.kind] === kind)
          .map((issue) => ({ kind: issue.kind, lineIds: issue.lineIds, ...issue.detail })),
      },
    });
  }

  const clear = TAX_EXCEPTION_KINDS.filter((kind) => !byKind.has(kind));
  if (clear.length > 0) await closeExceptionsFor(principal, orderId, clear);
}
