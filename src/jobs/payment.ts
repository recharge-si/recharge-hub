import {
  findPaymentType,
  getFallbackPaymentType,
} from "~/adapters/db/repositories/payment-type-map.server";
import type { Principal } from "~/domain/types";

/**
 * Which MetaKocka payment type an order's gateway maps to (CLAUDE.md §8.7).
 *
 * One resolver for both moments a payment can be recorded — folded into the
 * `put_document` that creates the sales order, or sent afterwards when Shopify
 * says the order has been paid — because the two must never disagree about
 * which type a gateway means.
 *
 * Nothing here guesses. `payment_type` has to match a type in the merchant's
 * own MetaKocka register and no endpoint lists them (§3), so every candidate
 * this returns is a value the merchant entered: a mapping for the gateway, or
 * the fallback they chose for gateways with none.
 */

export type PaymentDecision =
  /** Do not record a payment. Not a failure — see the COD note below. */
  | { kind: "none"; reason: string }
  /** A human decides. Never a guess at a payment type or an amount. */
  | {
      kind: "exception";
      exception: "unmapped_payment_gateway";
      message: string;
      detail?: Record<string, unknown>;
    }
  | { kind: "pay"; paymentType: string; viaFallback: boolean };

/**
 * When the payment is being resolved.
 *
 * The distinction exists for exactly one case, and it is the case that made
 * this app miss payments in the first place.
 *
 * **Cash on delivery is not paid at order time** (§8.7): the money does not
 * exist yet, and marking the document paid on creation misstates the books.
 * That rule is about *order time*, though, and it was previously enforced as
 * "never" — so a COD order that the courier collected and Shopify duly marked
 * paid stayed unpaid in the ERP for good. At `settle`, Shopify saying the order
 * is paid is a statement about money that has actually changed hands, and it is
 * recorded like any other.
 */
export type PaymentPhase = "create" | "settle";

const COD_PATTERN = /cash[ _-]?on[ _-]?delivery|\bcod\b|povzetj/i;

export function isCashOnDelivery(gateway: string | null): boolean {
  return gateway !== null && COD_PATTERN.test(gateway);
}

export async function resolvePaymentType(
  principal: Principal,
  input: { gateway: string | null; phase: PaymentPhase },
): Promise<PaymentDecision> {
  if (!input.gateway) {
    return {
      kind: "exception",
      exception: "unmapped_payment_gateway",
      message:
        "Shopify did not name a payment gateway for this order, so there is no MetaKocka payment type to use. Record the payment in MetaKocka by hand.",
    };
  }

  if (input.phase === "create" && isCashOnDelivery(input.gateway)) {
    return {
      kind: "none",
      reason:
        "Cash on delivery is not paid at order time. The payment is recorded when Shopify reports the order as paid.",
    };
  }

  const mapped = await findPaymentType(principal, input.gateway);

  // The fallback answers the question the mapping table leaves open: gateways
  // appear without warning — a new provider, a manual method renamed in
  // Shopify — and before it existed every one of them left an order unpaid and
  // a person to chase. The merchant names the fallback themselves and the
  // settings screen will not save without one.
  const fallback = mapped ? null : await getFallbackPaymentType(principal);
  const paymentType = mapped ?? fallback;

  if (!paymentType) {
    return {
      kind: "exception",
      exception: "unmapped_payment_gateway",
      message: `The gateway "${input.gateway}" is not mapped to a MetaKocka payment type and no fallback type is set, so no payment was recorded. Map it on the Payment types page, then retry.`,
      detail: { gateway: input.gateway },
    };
  }

  return { kind: "pay", paymentType, viaFallback: mapped === null };
}
