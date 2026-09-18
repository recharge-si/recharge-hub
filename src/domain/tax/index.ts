/**
 * The tax domain, in one import.
 *
 * Shopify transaction tax → `NormalizedOrderTax` (the Shopify adapter) →
 * `decideOrderTax` → `TaxDecision` → the MetaKocka adapter reads
 * `metakockaTaxFactor` per line. Refunds read the stored decision back through
 * `reverseTaxForRefund`; the screens read `computeTaxDiagnostics`.
 */
export * from "~/domain/tax/types";
export * from "~/domain/tax/rates";
export * from "~/domain/tax/eu";
export * from "~/domain/tax/config";
export { decideOrderTax } from "~/domain/tax/decide";
export * from "~/domain/tax/refunds";
export * from "~/domain/tax/diagnostics";
