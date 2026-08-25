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
import { getSalesOrderSettings } from "~/adapters/db/repositories/sales-order-setting.server";
import {
  applyPrimaryDocument,
  claimDocument,
  getOrderDetail,
  recordDocumentRequest,
  recordDocumentResult,
  recordPaymentMark,
} from "~/adapters/db/repositories/order.server";
import { listCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { taxFactorFromPercent } from "~/adapters/metakocka/products";
import {
  buildSalesOrderBody,
  lookupSalesOrderByBuyerOrder,
  putSalesOrder,
  updateSalesOrder,
  type SalesOrderInput,
} from "~/adapters/metakocka/documents";
import {
  MetakockaError,
  describeForMerchant,
  exceptionKindFor,
} from "~/adapters/metakocka/errors";
import { parseOrderSafe } from "~/adapters/shopify/order-payload";
import { getLogger } from "~/adapters/observability/logger.server";
import { ensureOrderPartner } from "~/jobs/resolve-order-partner";
import { computeDocumentShares } from "~/jobs/order-shares";
import { resolvePaymentType } from "~/jobs/payment";
import { parsePartnerOverride } from "~/domain/orders/partner";
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
  // A document that went through is proof every SKU on it is in the catalogue,
  // which is the only thing that proves it. The allocation job cannot: it knows
  // whether a line has a SKU, not whether MetaKocka has the product.
  "sku_not_in_metakocka",
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
  const parsed = parseOrderSafe(order.rawPayload);

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

  // Somebody else is mid-write. Not ours to touch — this is the duplicate guard
  // doing its job (§8.4).
  if (!claim) {
    log.info(
      { shop: shopDomain, orderId, countCode },
      "Sales order already claimed by another job, skipping",
    );
    return;
  }

  // §8.6: shipping, COD surcharge and order-level discount belong to exactly
  // one document. Which one is decided from the whole order, not from this
  // source alone, so the same answer comes out however the jobs interleave —
  // and it is computed by the same function the payment job uses, so the two
  // can never disagree about what a document is worth.
  const shares = await computeDocumentShares(orderId);
  const share = shares.find((entry) => entry.sourceId === supplySourceId);
  const isPrimary = share?.isPrimary ?? false;

  /*
   * Which document is primary is a fact about the order, so it is written for
   * the whole order rather than for this job's document. Setting only this one
   * left the previous primary still flagged when an allocation moved, and an
   * order with two primary documents has the shipping on both.
   */
  await applyPrimaryDocument(
    orderId,
    shares.find((entry) => entry.isPrimary)?.sourceId ?? null,
  );

  /*
   * Who to file the order against.
   *
   * A partner the merchant entered by hand wins over the payload. It only
   * exists because Shopify had no address at all — point of sale, digital
   * goods, some draft orders — and MetaKocka will not take a sales order
   * without one, so before this the order simply could not move and the advice
   * was to go and edit it in Shopify.
   */
  const override = parsePartnerOverride(order.partnerOverride);
  const partner = override ?? parsed?.partner ?? parsed?.receiver ?? null;

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
        "This order has no billing or shipping address, and MetaKocka needs a partner on every sales order. Enter the customer details on the order page under “Customer details for MetaKocka”, or add the address in Shopify, then retry.",
    });
    await recordDocumentResult(claim.id, { status: "failed" });
    return;
  }

  const client = new MetakockaClient({
    companyId: credential.companyId,
    secretKey: credential.secretKey,
  });

  /*
   * §8.7, and it goes into the create rather than following it: MetaKocka
   * treats an update as a replacement, so a separate `mark_paid` call that
   * omits `product_list` deletes every line on the document.
   *
   * **Each document carries its own share, not just the primary one.** This
   * previously paid the primary and left every other document of a split order
   * unpaid, which understated the payment by the rest of the order. §8.7 says
   * each document is marked paid for its own share and §8.6 makes the shares
   * sum to the Shopify total exactly, so there is no double counting to avoid:
   * that would only happen if each document were paid the *order* total.
   */
  /*
   * No share, no payment — and the fallback that used to be here is why.
   *
   * `share` is undefined when this source is not in the current allocation,
   * which happens after a line moves to another warehouse. Falling back to the
   * order total then paid the *whole order* against a document that no longer
   * describes any of it: order 1007, one line at 209.00, ended up recorded as
   * 418.00 paid across two documents. §8.6's shares sum to the order total by
   * construction, so anything outside them is not a share of anything.
   */
  const payment = share
    ? await resolvePayment(principal, {
        orderId,
        gateway: order.paymentGateway ?? parsed?.gateway ?? null,
        financialStatus: order.financialStatus,
        paidAt: order.receivedAt,
        amountMinor: share.totalMinor,
      })
    : null;

  const salesOrder: SalesOrderInput = {
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
  };

  /*
   * Exactly the bytes that would go to MetaKocka.
   *
   * Built here rather than inside `putSalesOrder` because it is needed twice:
   * once to send, and once to compare against what was sent last time. The
   * builder is deterministic, so the two are the same document.
   */
  const desired = buildSalesOrderBody(salesOrder);

  /**
   * Rewrites a document MetaKocka already holds, when the order has moved.
   *
   * §8.8 originally ended the story at "written": a document was never touched
   * again, so an order edited in Shopify afterwards left the ERP holding
   * quantities nobody had agreed to and an exception the merchant could read
   * but not act on. Whether this runs at all is the merchant's choice
   * (`sales_order_setting`), because replacing a document that has been
   * invoiced changes an accounting record and only they know whether it has.
   */
  async function updateExistingDocument(): Promise<void> {
    const existing = await prisma.metakockaDocument.findUnique({
      where: { id: claim!.id },
      select: { mkId: true, requestBody: true, paymentMarkedAt: true },
    });

    // Nothing to update against. A document with no MetaKocka id was never
    // really written, and the next run re-claims it as a create.
    if (!existing?.mkId) return;

    if (sameDocument(existing.requestBody, desired)) {
      log.info(
        { shop: shopDomain, orderId, countCode },
        "Sales order already matches what would be sent, nothing to do",
      );
      return;
    }

    const settings = await getSalesOrderSettings(principal);

    /*
     * Two ways to be told not to touch it, and they mean different things.
     *
     * Updates off is a standing preference. Updates-off-after-payment is the
     * safety rail: a paid document is the one most likely to have been invoiced
     * in MetaKocka. Either way the merchant gets an exception naming the
     * difference rather than silence — which is the behaviour §8.8 always had.
     */
    const blocked = !settings.updateOnChange
      ? "updates to orders already sent are turned off"
      : existing.paymentMarkedAt && !settings.updateAfterPaid
        ? "the payment for this order has already been recorded in MetaKocka, and updating a paid document is turned off"
        : null;

    if (blocked) {
      await raiseException(principal, {
        orderId,
        kind: "order_diverged",
        message: `Order ${order!.shopifyOrderNumber} has changed in Shopify since ${countCode} was sent, and the MetaKocka document was not updated because ${blocked}. Correct it in MetaKocka by hand, or change this on the Sales orders settings page.`,
        detail: { countCode, reason: blocked },
      });

      await prisma.metakockaDocument.update({
        where: { id: claim!.id },
        data: { mkStatus: "behind Shopify" },
      });
      return;
    }

    /*
     * The payment goes back on the document.
     *
     * MetaKocka treats an update as a replacement and §8.7 adds that
     * `mark_paid` on an update deletes the previous payment — so a paid
     * document updated without one silently stops being paid. Normally the
     * payment resolver produces it again, but if Shopify has since moved off
     * `paid` it returns nothing, and the payment already recorded is carried
     * over from the body that recorded it.
     */
    const body: Record<string, unknown> = { ...desired };
    if (existing.paymentMarkedAt && body.mark_paid === undefined) {
      const previous = (existing.requestBody as { mark_paid?: unknown } | null)
        ?.mark_paid;
      if (previous !== undefined) body.mark_paid = previous;
    }

    try {
      const { body: sent, verified } = await updateSalesOrder(client, {
        mkId: existing.mkId,
        body,
      });

      await recordDocumentResult(claim!.id, {
        status: "written",
        requestBody: sent,
        responseBody: { updated: true, lines: verified.lineCount },
      });

      await prisma.metakockaDocument.update({
        where: { id: claim!.id },
        data: { mkStatus: "in step", mkCheckedAt: new Date() },
      });

      await prisma.allocation.updateMany({
        where: { supplySourceId, orderLine: { orderId } },
        data: { status: "written_to_metakocka" },
      });

      // The document now says what the order says, so nothing about the
      // difference still needs a person.
      await closeExceptionsFor(principal, orderId, [
        ...WRITE_FAILURE_KINDS,
        "order_diverged",
        "metakocka_document_changed",
      ]);

      await prisma.order.updateMany({
        where: { id: orderId, divergedAt: { not: null } },
        data: { divergedAt: null },
      });

      await appendEvent(principal, {
        entityType: "order",
        entityId: orderId,
        event: "order.document_updated",
        detail: {
          countCode,
          mkId: existing.mkId,
          source: source!.name,
          lines: perSourceLines.length,
          paymentKept: existing.paymentMarkedAt !== null,
        },
      });

      log.info(
        { shop: shopDomain, orderId, countCode },
        "Sales order updated in MetaKocka",
      );
    } catch (error) {
      /*
       * The document is still there and still MetaKocka's. It is not marked
       * failed — that would invite the next run to write a second one — so the
       * status stays written and the response records what went wrong.
       */
      await prisma.metakockaDocument.update({
        where: { id: claim!.id },
        data: {
          mkStatus: "update refused",
          responseBody:
            error instanceof MetakockaError
              ? { oprCode: error.oprCode, oprDesc: error.oprDesc }
              : { error: String(error) },
        },
      });

      if (error instanceof MetakockaError && error.kind === "exception") {
        await raiseException(principal, {
          orderId,
          kind: "order_diverged",
          message: `Order ${order!.shopifyOrderNumber} changed in Shopify, and MetaKocka refused the update to ${countCode}. ${describeForMerchant(error)} The document is unchanged. Correct it in MetaKocka by hand.`,
          detail: { countCode, oprCode: error.oprCode },
        });
        return;
      }

      throw error;
    }
  }

  /**
   * Resolves a previous attempt whose outcome nobody knows.
   *
   * §3, verified as Finding C: MetaKocka does not treat `count_code` as unique
   * — re-sending one creates a *second* document under MetaKocka's own
   * numbering. So a `put_document` that timed out, hit a 5xx, or whose job died
   * before recording the answer must never be blindly re-sent. The reference
   * that *is* searchable is `buyer_order` (Finding B), so the question is asked
   * before anything goes out: does MetaKocka already hold our document?
   *
   * Three answers, three directions:
   *
   *  - "Cannot find document" — the definitive no. Nothing with this order's
   *    reference exists, so the earlier call never landed and sending is safe.
   *    Returns false and the create path proceeds.
   *  - Our `count_code` answers — the earlier call landed. The document is
   *    adopted as written, nothing is sent, and the hourly drift poller
   *    (§8.11) checks its content against the recorded request like any other
   *    written document.
   *  - A *sibling* answers — a split order where another source's document
   *    exists. `get_document` by `buyer_order` returns one document and which
   *    one is not documented, so this says nothing about ours. The safe
   *    direction is to stop and ask: an exception names the count code for the
   *    merchant to check in MetaKocka, because the alternative — assuming
   *    absence — is exactly the duplicate §3 warns about.
   */
  async function resolveAmbiguousAttempt(): Promise<boolean> {
    const found = await lookupSalesOrderByBuyerOrder(
      client,
      order!.customerOrderRef,
    );

    if (found === null) return false;

    if (found.countCode === countCode) {
      await recordDocumentResult(claim!.id, {
        status: "written",
        mkId: found.mkId,
        responseBody: {
          recovered: true,
          mkId: found.mkId,
          docNumber: found.docNumber,
        },
      });

      await prisma.allocation.updateMany({
        where: { supplySourceId, orderLine: { orderId } },
        data: { status: "written_to_metakocka" },
      });

      await closeExceptionsFor(principal, orderId, [...WRITE_FAILURE_KINDS]);

      // The body that landed carried `mark_paid`, and MetaKocka confirms a
      // payment on the document — record it so `mark-metakocka-paid` does not
      // send a second one (§8.7: exactly once). When MetaKocka does not
      // confirm one, nothing is recorded: the later payment path then records
      // it properly, and re-marking an identical payment is the harmless
      // direction to be wrong in.
      if (payment && found.hasPayment === true) {
        await recordPaymentMark(claim!.id, {
          at: new Date(),
          paymentType: payment.paymentType,
          amountMinor: payment.amountMinor,
        });
      }

      await appendEvent(principal, {
        entityType: "order",
        entityId: orderId,
        event: "order.document_recovered",
        detail: {
          countCode,
          mkId: found.mkId,
          source: source!.name,
          reason:
            "an earlier attempt had no recorded outcome, and the document was found in MetaKocka by its order reference",
        },
      });

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
        { shop: shopDomain, orderId, countCode, mkId: found.mkId },
        "Sales order recovered from MetaKocka after an ambiguous failure",
      );
      return true;
    }

    await recordDocumentResult(claim!.id, {
      status: "failed",
      responseBody: {
        lookupInconclusive: true,
        answeredCountCode: found.countCode,
      },
    });

    await raiseException(principal, {
      orderId,
      kind: "metakocka_write_failed",
      message: `An earlier attempt to send ${countCode} to MetaKocka got no answer, so it may or may not exist there — and because this order has more than one document, the lookup could not tell. Check in MetaKocka whether a sales order ${countCode} exists: if it does not, retry this order; if it does, mark this as resolved.`,
      detail: { countCode, answeredCountCode: found.countCode },
    });

    await prisma.allocation.updateMany({
      where: { supplySourceId, orderLine: { orderId } },
      data: { status: "failed" },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "needs_attention" },
    });

    return true;
  }

  if (claim.alreadyWritten) {
    await updateExistingDocument();
    return;
  }

  try {
    /*
     * The request is recorded before the call goes out (§8.4: "records request
     * and response bodies regardless of outcome"). After a timeout the
     * response is exactly what nobody has, and the recorded request is what
     * tells the drift poller — and anyone reading the row — what MetaKocka may
     * be holding.
     */
    await recordDocumentRequest(claim.id, desired);

    /*
     * A re-taken claim whose previous attempt was not an explicit MetaKocka
     * rejection is ambiguous, and §3 forbids resolving ambiguity by sending:
     * look first. Only a definitive rejection (`opr_code` recorded) proves no
     * document was created and lets the retry go straight to the write.
     */
    if (claim.reclaimed && !claim.previousRejection) {
      const resolved = await resolveAmbiguousAttempt();
      if (resolved) return;
    }

    const { body, result } = await putSalesOrder(client, salesOrder);

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

    // Records what was paid, not only that it was: a split order pays each
    // document its own share, and the shares have to be shown to add up. It is
    // also what stops `mark-metakocka-paid` sending a second payment for a
    // document that already carries one (§8.7).
    if (payment) {
      await recordPaymentMark(claim.id, {
        at: new Date(),
        paymentType: payment.paymentType,
        amountMinor: payment.amountMinor,
      });
    }

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
 * What payment, if any, a document should be created with (§8.7).
 *
 * This decides; it does not write. Payment travels in the `put_document` that
 * creates the order, because a follow-up update is destructive: MetaKocka
 * treats an update as a replacement, and an update omitting `product_list`
 * silently deletes every line on the document. §8.7's other warning still
 * holds — `mark_paid` on an update replaces the previous payment — and both are
 * avoided by never updating in the first place.
 *
 * Which payment *type* is a question for `jobs/payment`, shared with the job
 * that records a payment arriving later, so a gateway cannot mean one type at
 * order time and another an hour afterwards. What is decided here is the part
 * that is specific to creating a document:
 *
 *  - `pending` and `authorized` create the order and are **not** marked paid.
 *  - `paid` is marked paid, dated from the order, for this document's share.
 *  - `partially_paid` raises an exception rather than guessing an amount.
 *  - Cash on delivery is not paid at order time, whatever Shopify says. It is
 *    recorded when Shopify reports the money as collected, by
 *    `mark-metakocka-paid` — which is a change from this being "never", and the
 *    reason COD orders used to stay unpaid in the ERP permanently.
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

  const decision = await resolvePaymentType(principal, {
    gateway: input.gateway,
    phase: "create",
  });

  if (decision.kind === "none") return null;

  if (decision.kind === "exception") {
    await raiseException(principal, {
      orderId: input.orderId,
      kind: decision.exception,
      message: decision.message,
      detail: decision.detail,
    });
    return null;
  }

  await appendEvent(principal, {
    entityType: "order",
    entityId: input.orderId,
    event: "order.payment_marked",
    detail: {
      paymentType: decision.paymentType,
      gateway: input.gateway,
      amountMinor: input.amountMinor,
      // Worth having in the trail: a payment recorded against a type the
      // merchant never chose for this gateway reads differently in a
      // reconciliation than one that was mapped deliberately.
      viaFallback: decision.viaFallback,
      when: "with the sales order",
    },
  });

  return {
    paymentType: decision.paymentType,
    paidAt: input.paidAt,
    amountMinor: input.amountMinor,
  };
}

/**
 * Whether two document bodies say the same thing.
 *
 * Key order cannot be relied on: one side has been through a Postgres `jsonb`
 * column, which reorders object keys, so a plain `JSON.stringify` comparison
 * would report every document as changed on the first pass after it was
 * written. Sorting the keys first makes the comparison about content.
 *
 * Deliberately compares the whole body rather than the lines. Everything in it
 * is something MetaKocka was told — the pricelist, the warehouse, the profit
 * centre, the partner, the tax on each line — so any of them drifting counts,
 * and something the app never sends cannot.
 */
export function sameDocument(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` never survives a round trip through the database, so a key
    // holding one has to read as absent on both sides.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
