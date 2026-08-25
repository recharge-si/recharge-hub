import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  closeExceptionsFor,
  raiseException,
} from "~/adapters/db/repositories/exception.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import {
  claimDocument,
  getOrderDetail,
  markDocumentPaymentSent,
  recordDocumentResult,
} from "~/adapters/db/repositories/order.server";
import {
  findPaymentType,
  getFallbackPaymentType,
} from "~/adapters/db/repositories/payment-type-map.server";
import { listCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { taxFactorFromPercent } from "~/adapters/metakocka/products";
import { putSalesOrder } from "~/adapters/metakocka/documents";
import {
  MetakockaError,
  describeForMerchant,
  exceptionKindFor,
} from "~/adapters/metakocka/errors";
import { parseOrder } from "~/adapters/shopify/order-payload";
import { getLogger } from "~/adapters/observability/logger.server";
import { ensureOrderPartner } from "~/jobs/resolve-order-partner";
import { splitOrderMoney } from "~/domain/money/split";
import { serviceToken, shopDomainOf, type Principal } from "~/domain/types";

/**
 * The kinds a failed write can be filed under. They describe one event — this
 * document was refused — so only the current one is ever left open.
 */
const WRITE_FAILURE_KINDS = [
  "profit_center_rejected",
  "warehouse_invalid",
  "tax_undeterminable",
  "unmapped_payment_gateway",
  "metakocka_write_failed",
] as const;

export const writeMetakockaOrderJobSchema = z.object({
  shopDomain: z.string().min(1),
  orderId: z.string().min(1),
  supplySourceId: z.string().min(1),
});

/**
 * Writes one MetaKocka sales order, for one supply source (CLAUDE.md §8.4).
 *
 * One job per source, because `warehouse` and `profit_center` are
 * document-level (§3): a split order is N documents, not one document with
 * mixed lines.
 *
 * The order of operations is not arbitrary, and each step exists because of
 * something MetaKocka verifiably does:
 *
 *  1. **Claim the `count_code` first.** §3 verified that MetaKocka does not
 *     treat it as unique — re-sending one creates a second document under
 *     MetaKocka's own numbering, which can then no longer be found by the code
 *     we sent. The unique index on `metakocka_document` is the only duplicate
 *     guard that exists, so it is taken before the call, not after.
 *  2. **Validate the warehouse mark against `warehouse_list`.** §3 verified
 *     that an unknown warehouse is silently accepted and the document filed
 *     against the company default. MetaKocka will not tell us; we have to look.
 *  3. **Send `price_with_tax`** — the documentation is explicit that webshop
 *     orders always should.
 *  4. **Record the request and response either way**, success or failure.
 *
 * `create_invoice` is deliberately never set. Invoicing stays a merchant
 * decision (§8.4).
 */
export async function handleWriteMetakockaOrder(
  job: Job<unknown>,
): Promise<void> {
  const { shopDomain, orderId, supplySourceId } =
    writeMetakockaOrderJobSchema.parse(job.data);
  const principal = serviceToken(shopDomain, "write-metakocka-order");
  const log = getLogger();

  const order = await getOrderDetail(principal, orderId);
  if (!order) return;

  const source = await prisma.supplySource.findFirst({
    where: { id: supplySourceId, shop: { domain: shopDomainOf(principal) } },
  });
  if (!source) return;

  const productSettings = await getProductSyncSetting(principal);
  const credential = await getCredential(principal);
  if (!credential) {
    await raiseException(principal, {
      orderId,
      kind: "metakocka_write_failed",
      message:
        "MetaKocka is not connected, so this order could not be sent. Add the credentials on the Connection page and retry.",
    });
    return;
  }

  // Which lines this source is responsible for, and how many of each.
  const perSourceLines = order.lines.flatMap((line) =>
    line.allocations
      .filter((allocation) => allocation.supplySourceId === supplySourceId)
      .map((allocation) => ({ line, quantity: allocation.quantity })),
  );

  if (perSourceLines.length === 0) return;

  const missingSku = perSourceLines.filter(
    (entry) => entry.line.sku.trim() === "",
  );
  if (missingSku.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "sku_not_in_metakocka",
      message: `This order has ${missingSku.length} ${missingSku.length === 1 ? "line" : "lines"} with no SKU, so no MetaKocka product can be matched. Add a SKU in Shopify and retry.`,
      detail: { lines: missingSku.map((entry) => entry.line.title) },
    });
    return;
  }

  /*
   * Every line must be a catalogue product, checked here rather than left to
   * MetaKocka.
   *
   * MetaKocka's own answer to an unknown code is
   * `opr_code 8, "Product with code X not found - unit must be set to add new
   * product"`, which is a standing invitation: send `unit` and it will create
   * the product from the order line. That is how a catalogue fills up with
   * entries nobody curated, priced and named from whatever Shopify happened to
   * send. The document builder never sends `unit`, and this stops the order
   * before the call so the merchant is told which SKU is missing rather than
   * reading a rejection.
   */
  const matched = await prisma.sku.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      sku: { in: perSourceLines.map((entry) => entry.line.sku) },
      status: "matched",
    },
    select: { sku: true },
  });
  const inCatalogue = new Set(matched.map((row) => row.sku));

  const unknown = perSourceLines.filter(
    (entry) => !inCatalogue.has(entry.line.sku),
  );
  if (unknown.length > 0) {
    const skus = [...new Set(unknown.map((entry) => entry.line.sku))];
    await raiseException(principal, {
      orderId,
      kind: "sku_not_in_metakocka",
      message: `MetaKocka has no product with ${skus.length === 1 ? "the code" : "the codes"} ${skus.join(", ")}, and this app will not let an order invent one. Create ${skus.length === 1 ? "it" : "them"} in MetaKocka, or turn on creating missing products on the product sync page and run a sync, then retry.`,
      detail: { skus },
    });
    return;
  }

  // §3: an unknown warehouse mark is accepted silently and the document is
  // filed against the company default. Validating it here is the only thing
  // that turns a silent mis-filing into something a merchant can see.
  const warehouses = await listCachedWarehouses(principal);
  const markIsKnown =
    !source.metakockaWarehouse ||
    warehouses.some(
      (warehouse) => warehouse.mark === source.metakockaWarehouse,
    );

  if (!markIsKnown) {
    await raiseException(principal, {
      orderId,
      kind: "warehouse_invalid",
      message: `MetaKocka has no warehouse with the mark "${source.metakockaWarehouse}", and it accepts an unknown mark without complaining — the order would be filed against the company default. Reload the warehouse list and check the mapping for ${source.name}.`,
      detail: { mark: source.metakockaWarehouse, source: source.name },
    });
    return;
  }

  // The addresses come from the stored payload rather than being kept as
  // columns: §2.4 says store only what is sent, and the retention job redacts
  // this in place after 90 days without touching the decision trail.
  const parsed = order.rawPayload ? parseOrder(order.rawPayload) : null;

  /**
   * Tax, re-derived from the payload rather than read off the row.
   *
   * `order_line.tax_factor` records what the parser made of the order the day
   * it arrived. That is the right thing to store, but it means a parser fix can
   * never reach an order that is already in the database — and this one landed
   * exactly there: three lines saved as "unknown" by an older rule that today
   * reads as a definite zero, with a retry that could only ever reproduce the
   * same failure.
   *
   * So while the payload is still here, it wins. Past the 90-day redaction it
   * is gone (§2.4) and the stored value is all there is, which is why the
   * fallback exists rather than this being a straight replacement.
   */
  const freshTax = new Map(
    (parsed?.lines ?? []).map((line) => [
      line.shopifyLineItemId,
      line.taxFactor,
    ]),
  );
  /**
   * The shop's own VAT rate, used when Shopify did not supply one.
   *
   * MetaKocka will not take a line without a tax attribute — it answers
   * "Attribute 'tax' for product with code X must be set" — and it will not
   * infer one from the catalogue either. So a rate has to come from somewhere,
   * and the merchant's configured rate is the only honest source: it is the one
   * their catalogue and pricelist are built on.
   *
   * Sending zero instead, which this used to do, produced a line of 209.00 at
   * 0% against a pricelist that says 171.31 at 22% — the right gross, a net
   * matching nothing, and VAT understated to the tax office.
   */
  const defaultTaxFactor = taxFactorFromPercent(productSettings.taxPercent);

  const taxFactorFor = (line: {
    shopifyLineItemId: string;
    taxFactor: string | null;
  }) =>
    freshTax.get(line.shopifyLineItemId) ?? line.taxFactor ?? defaultTaxFactor;

  // §11: MetaKocka refuses a line whose product has no tax attribute unless the
  // line carries one, and §8.6 forbids substituting a product default. When
  // Shopify has not said enough to derive the rate, that is a human's decision,
  // not ours to guess at.
  const withoutTax = perSourceLines.filter(
    (entry) => taxFactorFor(entry.line) === null,
  );
  if (withoutTax.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "tax_undeterminable",
      message: `Shopify did not give a tax rate for ${withoutTax.length === 1 ? "one line" : `${withoutTax.length} lines`} on this order, and MetaKocka will not accept a line without one. Set the default VAT rate on the product sync page so it matches your pricelist, or fix the tax settings for this market in Shopify, then retry.`,
      detail: { skus: withoutTax.map((entry) => entry.line.sku) },
    });
    return;
  }

  const countCode = `${order.customerOrderRef}-${source.code}`;

  const claim = await claimDocument(principal, {
    orderId,
    supplySourceId,
    countCode,
    isPrimary: false,
  });

  // Somebody else is writing this document, or it is already written. Either
  // way, not ours to send. This is the duplicate guard doing its job.
  if (!claim || claim.alreadyWritten) {
    log.info(
      { shop: shopDomain, orderId, countCode },
      "Sales order already claimed or written, skipping",
    );
    return;
  }

  // §8.6: shipping, COD surcharge and order-level discount belong to exactly
  // one document. Which one is decided from the whole order, not from this
  // source alone, so the same answer comes out however the jobs interleave.
  const totalsBySource = new Map<string, number>();
  for (const line of order.lines) {
    for (const allocation of line.allocations) {
      if (!allocation.supplySourceId) continue;
      const current = totalsBySource.get(allocation.supplySourceId) ?? 0;
      totalsBySource.set(
        allocation.supplySourceId,
        current + allocation.quantity * line.unitPriceWithTaxMinor,
      );
    }
  }

  const sources = await prisma.supplySource.findMany({
    where: { id: { in: [...totalsBySource.keys()] } },
  });

  const shares = splitOrderMoney({
    perSource: sources.map((entry) => ({
      sourceId: entry.id,
      sourceCode: entry.code,
      kind: entry.kind,
      lineTotalMinor: totalsBySource.get(entry.id) ?? 0,
    })),
    orderTotalMinor: order.totalMinor,
    shippingMinor: order.shippingMinor,
    discountMinor: order.discountMinor,
  });

  const share = shares.find((entry) => entry.sourceId === supplySourceId);
  const isPrimary = share?.isPrimary ?? false;

  if (isPrimary) {
    await prisma.metakockaDocument.update({
      where: { id: claim.id },
      data: { isPrimary: true },
    });
  }

  const partner = parsed?.partner ?? parsed?.receiver ?? null;

  // Falls back to resolving here for orders allocated before partners were
  // looked up, and for a retry after a MetaKocka blip during allocation.
  //
  // Anything that throws from here on has to leave the claim in a state a retry
  // can pick up. The first version of this let a failed partner lookup escape
  // after the count_code had been claimed, which left the document at "pending"
  // where nothing would ever touch it again. Marking it failed is what makes
  // the next attempt — pg-boss's own, or the merchant pressing the button — do
  // something instead of skipping.
  const resolvedPartner = await ensureOrderPartner(principal, orderId).catch(
    async (error: unknown) => {
      await recordDocumentResult(claim.id, {
        status: "failed",
        responseBody:
          error instanceof MetakockaError
            ? { oprCode: error.oprCode, oprDesc: error.oprDesc }
            : { error: String(error) },
      });
      throw error;
    },
  );

  if (!partner) {
    await raiseException(principal, {
      orderId,
      kind: "metakocka_write_failed",
      message:
        "This order has no billing or shipping address, and MetaKocka needs a partner on every sales order. Add the address in Shopify and retry.",
    });
    await recordDocumentResult(claim.id, { status: "failed" });
    return;
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  // §8.7, and it goes into the create rather than following it: an update that
  // omits product_list deletes every line on the document, which is what a
  // separate mark_paid call turned out to do.
  //
  // Only the primary document carries the payment. Spreading one Shopify
  // payment across every document of a split order would record the money
  // several times over.
  const payment = isPrimary
    ? await resolvePayment(principal, {
        orderId,
        gateway: parsed?.gateway ?? null,
        financialStatus: order.financialStatus,
        paidAt: order.receivedAt,
        amountMinor: share?.totalMinor ?? order.totalMinor,
      })
    : null;

  try {
    const { body, result } = await putSalesOrder(client, {
      countCode,
      // §3, verified: `buyer_order` is what links sibling documents.
      buyerOrder: order.customerOrderRef,
      docDate: order.receivedAt,
      currencyCode: order.presentmentCurrency,
      taxesIncluded: parsed?.taxesIncluded ?? true,
      partner: {
        ...partner,
        mkId: resolvedPartner?.mkId ?? null,
        mkAddressId: resolvedPartner?.mkAddressId ?? null,
      },
      // Buyer and receiver differ for gift and B2B orders, so they are mapped
      // separately rather than one being reused for both (§8.4).
      receiver: parsed?.receiver ?? null,
      salesPricelistCode: productSettings.pricelistCode,
      warehouse: source.metakockaWarehouse,
      profitCenter: source.metakockaProfitCenter,
      deliveryType: source.defaultDeliveryType,
      notes: isPrimary && parsed?.note ? parsed.note : null,
      markPaid: payment,
      lines: perSourceLines.map((entry) => ({
        code: entry.line.sku,
        amount: entry.quantity,
        priceWithTaxMinor: entry.line.unitPriceWithTaxMinor,
        taxFactor: taxFactorFor(entry.line),
      })),
    });

    await recordDocumentResult(claim.id, {
      status: "written",
      mkId: result.mkId,
      requestBody: body,
      responseBody: result,
    });

    await prisma.allocation.updateMany({
      where: {
        supplySourceId,
        orderLine: { orderId },
      },
      data: { status: "written_to_metakocka" },
    });

    // Bring the stored rows in line with what was sent, so the order page and
    // the decision trail do not keep showing the superseded derivation.
    for (const entry of perSourceLines) {
      const derived = taxFactorFor(entry.line);
      if (derived === entry.line.taxFactor) continue;
      await prisma.orderLine.update({
        where: { id: entry.line.id },
        data: { taxFactor: derived },
      });
    }

    // The write went through, so nothing about it still needs a human.
    await closeExceptionsFor(principal, orderId, [...WRITE_FAILURE_KINDS]);

    await appendEvent(principal, {
      entityType: "order",
      entityId: orderId,
      event: "order.document_written",
      detail: {
        countCode,
        mkId: result.mkId,
        source: source.name,
        isPrimary,
        lines: perSourceLines.length,
      },
    });

    if (payment) await markDocumentPaymentSent(claim.id, new Date());

    // Once every source has a document, the order is done.
    const remaining = await prisma.metakockaDocument.count({
      where: { orderId, status: { not: "written" } },
    });
    if (remaining === 0) {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "written" },
      });
    }

    log.info(
      { shop: shopDomain, orderId, countCode, mkId: result.mkId },
      "Sales order written to MetaKocka",
    );
  } catch (error) {
    // Only reached before the write is recorded: once recordDocumentResult has
    // marked it written, nothing here runs. An earlier version marked a
    // perfectly good document "failed" because a follow-up call tripped, which
    // then invited a retry that would have created a second one.
    await recordDocumentResult(claim.id, {
      status: "failed",
      responseBody:
        error instanceof MetakockaError
          ? { oprCode: error.oprCode, oprDesc: error.oprDesc }
          : { error: String(error) },
    });

    // §11: retryable failures go back to the queue and no human hears about
    // them; a business rejection goes to the exceptions queue and the job stops
    // retrying, because sending the identical payload again will fail the same
    // way.
    if (error instanceof MetakockaError && error.kind === "exception") {
      // From what MetaKocka said, not from its opr_code: code 6 covers a
      // missing profit centre and a malformed date alike.
      const kind = exceptionKindFor(error);

      // One failed write is one problem, however many ways it has been
      // described. `raiseException` only dedupes within a kind, so a retry that
      // fails differently — or that fails the same way after the classifier was
      // corrected — would leave the merchant reading two red banners about one
      // rejection, one of them stale and naming the wrong cause.
      await closeExceptionsFor(
        principal,
        orderId,
        WRITE_FAILURE_KINDS.filter((other) => other !== kind),
      );

      await raiseException(principal, {
        orderId,
        kind,
        message: describeForMerchant(error),
        detail: { countCode, source: source.name, oprCode: error.oprCode },
      });

      await prisma.allocation.updateMany({
        where: { supplySourceId, orderLine: { orderId } },
        data: { status: "failed" },
      });
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "needs_attention" },
      });
      return;
    }

    throw error;
  }
}

/**
 * What payment, if any, the primary document should be created with (§8.7).
 *
 * This decides; it does not write. Payment travels in the `put_document` that
 * creates the order, because a follow-up update is destructive: MetaKocka
 * treats an update as a replacement and an update omitting `product_list`
 * silently deletes every line on the document. §8.7's other warning still
 * holds — `mark_paid` on an update replaces the previous payment — and both are
 * avoided by never updating in the first place.
 *
 * The rules, from §8.7:
 *
 *  - `pending` and `authorized` create the order and are **not** marked paid.
 *  - `paid` is marked paid, dated from the order.
 *  - `partially_paid` raises an exception rather than guessing an amount.
 *  - Cash on delivery is not paid at order time, whatever Shopify says.
 *  - An unmapped gateway falls back to the type the merchant chose for exactly
 *    that case on the Payment types page, and raises an exception only when no
 *    fallback is set. That is still not a guess: `payment_type` has to match a
 *    type in the merchant's own MetaKocka register and no endpoint lists them
 *    (§3), so every candidate here came from the merchant.
 */
export async function resolvePayment(
  principal: Principal,
  input: {
    orderId: string;
    gateway: string | null;
    financialStatus: string;
    paidAt: Date;
    amountMinor: number;
  },
): Promise<{ paymentType: string; paidAt: Date; amountMinor: number } | null> {
  if (input.financialStatus === "partially_paid") {
    await raiseException(principal, {
      orderId: input.orderId,
      kind: "partially_paid",
      message:
        "This order is only partly paid in Shopify. The sales order was created but not marked paid, because a part payment cannot be guessed. Record the payment in MetaKocka, then resolve this.",
    });
    return null;
  }

  if (input.financialStatus !== "paid") return null;

  if (!input.gateway) {
    await raiseException(principal, {
      orderId: input.orderId,
      kind: "unmapped_payment_gateway",
      message:
        "Shopify did not name a payment gateway for this order, so there is no MetaKocka payment type to use. Record the payment in MetaKocka by hand.",
    });
    return null;
  }

  // Cash on delivery is not paid at order time. Marking it paid on creation
  // misstates the books, whatever Shopify's financial status says.
  if (/cash[ _-]?on[ _-]?delivery|\bcod\b/i.test(input.gateway)) return null;

  const mapped = await findPaymentType(principal, input.gateway);

  // The fallback answers the question the mapping table leaves open: gateways
  // appear without warning — a new provider, a manual method renamed in
  // Shopify — and before this, every one of them left an order unpaid and a
  // person to chase. The merchant names the fallback themselves and the
  // settings screen will not save without one.
  const fallback = mapped ? null : await getFallbackPaymentType(principal);
  const paymentType = mapped ?? fallback;

  if (!paymentType) {
    await raiseException(principal, {
      orderId: input.orderId,
      kind: "unmapped_payment_gateway",
      message: `The gateway "${input.gateway}" is not mapped to a MetaKocka payment type and no fallback type is set, so this order was created unpaid. Map it on the Payment types page, then retry.`,
      detail: { gateway: input.gateway },
    });
    return null;
  }

  await appendEvent(principal, {
    entityType: "order",
    entityId: input.orderId,
    event: "order.payment_marked",
    detail: {
      paymentType,
      gateway: input.gateway,
      // Worth having in the trail: a payment recorded against a type the
      // merchant never chose for this gateway reads differently in a
      // reconciliation than one that was mapped deliberately.
      viaFallback: mapped === null,
    },
  });

  return {
    paymentType,
    paidAt: input.paidAt,
    amountMinor: input.amountMinor,
  };
}
