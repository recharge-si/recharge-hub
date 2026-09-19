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
  listDocumentsForReconciliation,
  markOrderWrittenIfComplete,
  recordDocumentPayments,
  recordDocumentRequest,
  recordDocumentResult,
  recordPaymentMark,
  touchDocumentReconciled,
} from "~/adapters/db/repositories/order.server";
import { replaceApplicationsForDocument } from "~/adapters/db/repositories/order-payment.server";
import { isSyncActivated } from "~/adapters/db/repositories/shop.server";
import { getSupplyDefaults } from "~/adapters/db/repositories/supply-setting.server";
import { listCachedWarehouses } from "~/adapters/db/repositories/supply-source.server";
import { getTaxSnapshot } from "~/adapters/db/repositories/tax.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  buildSalesOrderBody,
  lookupSalesOrderByBuyerOrder,
  putSalesOrder,
  replaceDocumentPayments,
  updateSalesOrder,
  type DocumentPayment,
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
import {
  planPayments,
  readLedger,
  type PaymentPlanEntry,
} from "~/jobs/orders/payment-reconciler";
import { resolvePaymentType } from "~/jobs/payment";
import { parsePartnerOverride } from "~/domain/orders/partner";
import { WHOLE_ORDER_DOCUMENT } from "~/domain/orders/reconcile";
import { salesOrderNumberFor } from "~/domain/orders/reference";
import { negativeShares, type DocumentShare } from "~/domain/money/split";
import { serviceToken, shopDomainOf, type Principal } from "~/domain/types";
import { decideOrderTransfer, describeTransferHold } from "~/domain/orders/transfer";

/**
 * The kinds a failed write can be filed under. They describe one event — this
 * document was refused — so only the current one is ever left open.
 */
const WRITE_FAILURE_KINDS = [
  "profit_center_rejected",
  "warehouse_invalid",
  "tax_undeterminable",
  "tax_mapping_missing",
  "tax_treatment_unknown",
  "tax_data_insufficient",
  "tax_reconciliation_failed",
  "vat_registration_configuration_error",
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
 * A shop on `sales_order_split = single` has no sources to run per: the job is
 * called once with `WHOLE_ORDER_DOCUMENT` and writes one document carrying
 * every line of the order with **no warehouse mark**, which MetaKocka then
 * files against the company default. Everything else below — the count-code
 * claim, the ambiguous-write recovery, the update policy, the payment shares —
 * is the same code and the same rules; only the grouping differs.
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

  await writeMetakockaOrderFor(
    serviceToken(shopDomain, "write-metakocka-order"),
    { orderId, supplySourceId },
  );
}

export interface WriteMetakockaOrderInput {
  orderId: string;
  supplySourceId: string;
  /**
   * The complete set of payments this document should carry (§8.7).
   *
   * Supplied by the reconciler, which has already divided the order's ledger
   * across its documents. Omitted by the queue entry point above, which then
   * derives the same answer from the stored ledger — so there is exactly one
   * truth about what a document has been paid however the write was triggered.
   *
   * An empty plan is meaningful and different from `undefined`: it says "this
   * document should carry no payment", which is what a document whose receipt
   * moved to another warehouse needs.
   *
   * **`entries` travels with `payments` and is not optional in practice.** The
   * amounts alone are enough to build the body and not enough to record what
   * happened: `order_payment_application` is how the §24 invariant knows which
   * transaction each recorded share came from, and passing amounts without
   * identities would clear those rows and make the invariant permanently
   * unsatisfiable.
   */
  payments?: { payments: DocumentPayment[]; entries: PaymentPlanEntry[] };
}

/**
 * The write itself, callable directly.
 *
 * Exported so the per-order reconciler can run it **inside its own lock**
 * rather than enqueueing it: the lock exists to stop two passes deciding two
 * different warehouse splits, and releasing it before the documents were
 * written would give exactly that window away.
 */
export async function writeMetakockaOrderFor(
  principal: Principal,
  input: WriteMetakockaOrderInput,
): Promise<void> {
  const { orderId, supplySourceId } = input;
  const shopDomain = principal.shopDomain;
  const log = getLogger();

  /**
   * Whether this is the one document of an unsplit order.
   *
   * The caller decides — the reconciler reads `sales_order_split` — and passes
   * the sentinel rather than a source id. Read once here, so every branch below
   * asks the same question in the same way.
   */
  const wholeOrder = supplySourceId === WHOLE_ORDER_DOCUMENT;

  const order = await getOrderDetail(principal, orderId);
  if (!order) return;

  const source = wholeOrder
    ? null
    : await prisma.supplySource.findFirst({
        where: { id: supplySourceId, shop: { domain: shopDomainOf(principal) } },
      });
  if (!wholeOrder && !source) return;

  /*
   * The activation boundary (the product UX brief, section 11).
   *
   * Guided setup saves the MetaKocka credentials at its second step, so between
   * there and Finish setup a shop is connected without having chosen its
   * warehouses or its payment types. A sales order filed then is filed against
   * answers nobody finished giving, and nothing in this system deletes a
   * MetaKocka document. So the order is left alone; Finish setup enqueues a
   * reconciliation sweep that picks up everything that arrived meanwhile.
   *
   * No exception is raised, because this is not a failure — it is a merchant
   * partway through setup, which the home page is already saying.
   *
   * Shops that were synchronizing before this existed were back-filled by
   * `20260826080000_setup_state`, so nothing stops for them.
   */
  if (!(await isSyncActivated(principal))) {
    log.info(
      { shop: shopDomain, orderId },
      "Order not written to MetaKocka: setup has not been finished",
    );
    return;
  }

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

  /*
   * Which lines this document is responsible for, and how many of each.
   *
   * An unsplit order takes the order's own lines at full quantity: nothing was
   * allocated, because nothing was split. That deliberately includes quantity
   * Shopify is fulfilling through a service this app cannot see — with no
   * warehouse on the document there is no ERP stock to misstate, and a merchant
   * who asked for one sales order per Shopify order meant all of it.
   */
  const perSourceLines = wholeOrder
    ? order.lines.map((line) => ({ line, quantity: line.quantity }))
    : order.lines.flatMap((line) =>
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
  const salesOrderSettings = await getSalesOrderSettings(principal);

  /*
   * The transfer switch, checked here as well as in the reconciler.
   *
   * The reconciler calls this inline and has already decided; the queue entry
   * point is a retry that may fire long after the merchant turned transfer
   * off, and a retry is exactly the write they asked not to happen. A queued
   * write always concerns an order with a document row, so only the switch
   * itself can hold it.
   */
  const transfer = decideOrderTransfer(salesOrderSettings, {
    receivedAt: new Date(0),
    hasDocuments: true,
  });
  if (!transfer.allowed) {
    log.info(
      { shop: shopDomain, orderId, hold: transfer.reason },
      `Order not written to MetaKocka: ${describeTransferHold(transfer.reason)}`,
    );
    return;
  }

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

  /*
   * §3: an unknown warehouse mark is accepted silently and the document is
   * filed against the company default. Validating it here is the only thing
   * that turns a silent mis-filing into something a merchant can see.
   *
   * There is nothing to validate for an unsplit order. It carries no mark, and
   * being filed against the company default is what it is asking for rather
   * than something going quietly wrong.
   */
  if (source) {
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
  }

  // The addresses come from the stored payload rather than being kept as
  // columns: §2.4 says store only what is sent, and the retention job redacts
  // this in place after 90 days without touching the decision trail.
  const parsed = parseOrderSafe(order.rawPayload);

  /**
   * Tax, from the order's recorded decision and nowhere else (§42 of the
   * brief: validate before creating a document).
   *
   * The reconciler decides every order's VAT under `jobs/orders/tax-decider`
   * and stores the result. This job never decides anything about tax: it reads
   * the mapped `tax_factor` per line from that snapshot, and refuses without a
   * clean one. A queued retry that lands here before the order has been
   * decided, or after a decision that was blocked, is told to reconcile —
   * which is the one path that decides again.
   *
   * §3 verified that MetaKocka takes `tax_factor: "0"` without complaint and
   * files a financially wrong line; a line with no mapped factor is therefore
   * never sent with a stand-in.
   */
  const taxSnapshot = await getTaxSnapshot(principal, orderId);
  if (!taxSnapshot || !taxSnapshot.decision.ok) {
    await raiseException(principal, {
      orderId,
      kind: "tax_undeterminable",
      message: taxSnapshot
        ? `Order ${order.shopifyOrderNumber} has a VAT decision with unresolved issues, so no document was written. ${taxSnapshot.decision.issues
            .filter((issue) => issue.severity === "blocking")
            .map((issue) => issue.message)
            .join(" ")}`
        : `Order ${order.shopifyOrderNumber} has not had its VAT decided yet, so no document was written. Reconcile the order to decide it, then it is sent.`,
      detail: taxSnapshot
        ? { configVersion: taxSnapshot.decision.configVersion }
        : { configVersion: null },
    });
    return;
  }

  const taxByLine = new Map(
    taxSnapshot.decision.lines.map((line) => [line.lineId, line]),
  );

  const taxFactorFor = (line: { shopifyLineItemId: string }): string | null =>
    taxByLine.get(line.shopifyLineItemId)?.metakockaTaxFactor ?? null;

  const withoutTax = perSourceLines.filter(
    (entry) => taxFactorFor(entry.line) === null,
  );
  if (withoutTax.length > 0) {
    await raiseException(principal, {
      orderId,
      kind: "tax_undeterminable",
      message: `Order ${order.shopifyOrderNumber} has ${withoutTax.length === 1 ? "a line" : `${withoutTax.length} lines`} (${withoutTax.map((entry) => entry.line.sku).join(", ")}) that the recorded VAT decision does not cover, so no document was written. Reconcile the order to decide it again.`,
      detail: {
        skus: withoutTax.map((entry) => entry.line.sku),
        configVersion: taxSnapshot.decision.configVersion,
      },
    });
    return;
  }

  /** The shipping line's own factor, as Shopify taxed shipping. */
  const shippingTaxFactor =
    taxSnapshot.decision.shipping?.metakockaTaxFactor ?? null;

  /*
   * The app's internal claim key — **not** necessarily what MetaKocka is told.
   *
   * It is derived from `customer_order_ref`, which is frozen at intake, plus
   * the source code where there is one, so it is stable and collision-free
   * whatever the merchant does to their numbering settings. The unique index it
   * is claimed under is the only duplicate guard this connector has (§3, §8.4),
   * which is exactly why it must not follow a setting a merchant can change.
   */
  const countCode = source
    ? `${order.customerOrderRef}-${source.code}`
    : order.customerOrderRef;

  /*
   * The number the document is written under, which is what MetaKocka's screen
   * shows as *Sales ord. no.*
   *
   * Null means the merchant has handed numbering to MetaKocka: no `count_code`
   * is sent and the ERP's own sequence answers. Otherwise it is rendered from
   * their pattern, defaulting to the customer's order reference — which is what
   * every document written before this setting existed carries, so nothing
   * renumbers.
   */
  const proposedNumber = salesOrderNumberFor({
    numbering: salesOrderSettings.salesOrderNumbering,
    template: salesOrderSettings.salesOrderNumberTemplate,
    customerOrderRef: order.customerOrderRef,
    context: {
      name: parsed?.orderName ?? null,
      number: order.shopifyOrderNumber,
      id: order.shopifyOrderId,
      customerEmail: parsed?.customerEmail ?? null,
    },
    sourceCode: source?.code ?? null,
  });

  const claim = await claimDocument(principal, {
    orderId,
    // Null is the stored truth for an unsplit document: it belongs to no
    // warehouse. The sentinel exists only to key it in memory.
    supplySourceId: source ? supplySourceId : null,
    countCode,
    sentCountCode: proposedNumber,
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

  /**
   * The number this write actually uses, settled once.
   *
   * The claim wins over what was just proposed, because the claim is what was
   * recorded the first time this document was attempted — a pattern changed in
   * between must not renumber a document MetaKocka already holds.
   */
  const sentCountCode = claim.sentCountCode ?? proposedNumber;

  /**
   * What to call this document when telling the merchant something about it.
   *
   * Its number when it has one, and otherwise the order reference — which is
   * the `buyer_order` MetaKocka is verifiably searchable by (§3), so it is
   * still something they can act on. Never the internal claim key, which means
   * nothing on their screen.
   */
  const documentLabel = sentCountCode ?? order.customerOrderRef;

  // §8.6: shipping, COD surcharge and order-level discount belong to exactly
  // one document. Which one is decided from the whole order, not from this
  // source alone, so the same answer comes out however the jobs interleave —
  // and it is computed by the same function the payment job uses, so the two
  // can never disagree about what a document is worth.
  const shares = await computeDocumentShares(orderId, { wholeOrder });

  /*
   * A document worth less than nothing is not written.
   *
   * §8.6 puts the order-level discount on the primary document alone, so a
   * split order whose discount is bigger than the primary's own lines produces
   * a sales order for a negative amount beside a positive one. MetaKocka would
   * take it without a word — it validates almost nothing (§3) — and the pair
   * even sums to the Shopify total, so nothing downstream would ever notice.
   *
   * There is no arithmetic that rescues it: spreading the discount is
   * forbidden and moving it only moves the negative. So this stops, and a
   * person decides (§11).
   */
  const negative = negativeShares(shares);
  if (negative.length > 0) {
    const worst = negative
      .map(
        (entry) =>
          `${entry.sourceCode} (${(entry.totalMinor / 100).toFixed(2)} ${order.presentmentCurrency})`,
      )
      .join(", ");

    await raiseException(principal, {
      orderId,
      kind: "metakocka_write_failed",
      message:
        `The order-level discount on this order is larger than the lines on the document that carries it, so ${negative.length === 1 ? "one document" : `${negative.length} documents`} would be sent to MetaKocka for a negative amount: ${worst}. ` +
        "Nothing was written. Adjust the discount in Shopify, or allocate more of the order to that supply source, then retry.",
      detail: {
        shares: shares.map((entry) => ({
          sourceCode: entry.sourceCode,
          isPrimary: entry.isPrimary,
          lineTotalMinor: entry.lineTotalMinor,
          shippingMinor: entry.shippingMinor,
          discountMinor: entry.discountMinor,
          totalMinor: entry.totalMinor,
        })),
      },
    });
    await recordDocumentResult(claim.id, { status: "failed" });
    return;
  }

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
    wholeOrder
      ? null
      : (shares.find((entry) => entry.isPrimary)?.sourceId ?? null),
    { wholeOrder },
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
   * The two document-level attributes a supply source would have supplied.
   *
   * An unsplit document has no source to read them from, so the profit centre
   * comes from the shop default — the same value every inherited source carries
   * — and the delivery type is simply not sent, because there is no shop-level
   * answer to invent one from and MetaKocka has its own.
   */
  const supplyDefaults = wholeOrder ? await getSupplyDefaults(principal) : null;

  /** What the audit trail calls this document's origin. */
  const sourceLabel = source?.name ?? "the whole order, unsplit";

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
  /*
   * Which of the two payment worlds this write is in.
   *
   * The ledger is the newer and the authoritative one: individual Shopify
   * transactions, allocated across the order's documents, sent as the whole
   * desired `mark_paid` array so MetaKocka's replacement converges instead of
   * accumulating. When the reconciler calls this it hands the answer straight
   * in; when the queue calls it — a retry, a merchant pressing the button — it
   * is derived here from the stored ledger, so both routes agree.
   *
   * The `financial_status` path below it is what this app did before the
   * ledger existed, and it is kept for exactly one situation: an order with no
   * transactions recorded at all. That is an order from before this feature, or
   * one whose transactions could not be read. Guessing a payment from a display
   * status is worse than the ledger and much better than nothing.
   */
  const desiredPayment = await desiredPaymentsFor(principal, {
    orderId,
    supplySourceId,
    share,
    given: input.payments,
    order,
    parsed,
  });

  /*
   * The non-product money this document carries.
   *
   * `share` is this document's slice of the order's shipping and discount,
   * spread by merchandise value so the parts sum to the charge exactly once
   * across every document (`domain/money/split`). A document with no share of
   * a charge sends nothing for it, which is what stops a retired document
   * keeping stale postage.
   *
   * Neither is guessed. Shipping needs a product code the merchant has named
   * and a discount needs a mechanism they have chosen; without those the
   * reconciler has already raised `commercial_representation_missing` and this
   * simply sends the merchandise, so the order is short in a way that is
   * reported rather than silent.
   */
  const shippingMinor = share?.shippingMinor ?? 0;
  const discountMinor = share?.discountMinor ?? 0;

  const shippingLine =
    shippingMinor > 0 && salesOrderSettings.shippingProductCode
      ? {
          code: salesOrderSettings.shippingProductCode,
          amountMinor: shippingMinor,
          /*
           * Shipping's own rate, as Shopify taxed it (§27 of the brief) and
           * as the tax decision recorded it — never a product's rate copied
           * across. The decision refuses when it could not tell, so a null
           * here means the order had no taxable shipping to decide, and the
           * shipping share then carries no tax.
           */
          taxFactor: shippingTaxFactor,
        }
      : null;

  const discountValueMinor =
    discountMinor > 0 &&
    salesOrderSettings.discountRepresentation === "document_discount_value"
      ? discountMinor
      : null;

  const salesOrder: SalesOrderInput = {
    // The number, not the claim key. Null omits the field and lets MetaKocka
    // number the document itself.
    countCode: sentCountCode,
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
    /*
     * No warehouse for an unsplit order, and that is the setting doing its job:
     * MetaKocka files a document with no mark against the company default,
     * which is exactly what a shop that does not keep its warehouses here has
     * asked for.
     */
    warehouse: source ? source.metakockaWarehouse : null,
    profitCenter: source
      ? source.metakockaProfitCenter
      : (supplyDefaults?.defaultProfitCenter ?? null),
    deliveryType: source ? source.defaultDeliveryType : null,
    notes: isPrimary && parsed?.note ? parsed.note : null,
    shippingLine,
    discountValueMinor,
    ...(desiredPayment.kind === "ledger"
      ? { payments: desiredPayment.payments }
      : { markPaid: desiredPayment.payment }),
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

    /*
     * Two different questions, and conflating them was the bug this split
     * fixes.
     *
     * "Has the *order* changed?" decides whether to replace the document, and
     * the merchant's safety rails apply: a paid document may well have been
     * invoiced, and rewriting an invoiced document changes an accounting
     * record. "Have the *payments* changed?" is the payment path doing exactly
     * its job — a second capture arriving on an order that was already partly
     * paid — and blocking it under `updateAfterPaid` would mean the first
     * payment permanently prevents the second from ever being recorded.
     *
     * So the content comparison deliberately ignores `mark_paid`, and a
     * payments-only difference goes to the replacement below rather than
     * through the update policy.
     */
    const contentChanged = !sameDocument(
      contentOnly(existing.requestBody),
      contentOnly(desired),
    );
    const paymentsChanged = !sameDocument(
      paymentsOf(existing.requestBody),
      paymentsOf(desired),
    );

    if (!contentChanged && !paymentsChanged) {
      log.info(
        { shop: shopDomain, orderId, countCode },
        "Sales order already matches what would be sent, nothing to do",
      );
      await touchDocumentReconciled(claim!.id, new Date());
      return;
    }

    const settings = salesOrderSettings;

    /*
     * Only the payments moved.
     *
     * Sent as a complete replacement of `mark_paid` on the exact body MetaKocka
     * accepted, which is the one safe way to change a payment: §8.7 warns that
     * `mark_paid` on an update replaces the previous payment, and §3 that an
     * update omitting `product_list` deletes every line. Replaying the recorded
     * body with a new payment array uses both facts rather than tripping over
     * them — two captures become two entries, and sending the same array again
     * changes nothing.
     */
    if (!contentChanged) {
      if (!settings.syncPayments) return;

      try {
        const { body: sent, verified } = await replaceDocumentPayments(client, {
          mkId: existing.mkId,
          /*
           * The recorded body, plus the number the document is filed under.
           *
           * MetaKocka treats an update as a replacement (§3), and the body
           * recorded for a document the ERP numbered itself carries no
           * `count_code` — it had none to send. Replaying it as-is would ask
           * MetaKocka to replace a numbered document from a body with no
           * number, and what it does with that is not something §3 verified.
           * Sending back the number it gave us cannot be wrong: it is the one
           * the document already has.
           */
          body: {
            ...(existing.requestBody as Record<string, unknown>),
            ...(sentCountCode ? { count_code: sentCountCode } : {}),
          },
          payments:
            desiredPayment.kind === "ledger"
              ? desiredPayment.payments
              : desiredPayment.payment
                ? [desiredPayment.payment]
                : [],
        });

        await recordDocumentResult(claim!.id, {
          status: "written",
          requestBody: sent,
          responseBody: { paymentsUpdated: true, lines: verified.lineCount },
        });
        await recordDocumentPaymentState(claim!.id, desiredPayment, new Date());
        await touchDocumentReconciled(claim!.id, new Date());
        await closeExceptionsFor(principal, orderId, [
          "payment_write_failed",
          "unmapped_payment_gateway",
        ]);

        await appendEvent(principal, {
          entityType: "order",
          entityId: orderId,
          event: "order.payments_reconciled",
          detail: {
            countCode,
            mkId: existing.mkId,
            entries:
              desiredPayment.kind === "ledger"
                ? desiredPayment.payments.length
                : desiredPayment.payment
                  ? 1
                  : 0,
            totalMinor:
              desiredPayment.kind === "ledger"
                ? desiredPayment.payments.reduce(
                    (total, entry) => total + entry.amountMinor,
                    0,
                  )
                : (desiredPayment.payment?.amountMinor ?? 0),
          },
        });

        log.info(
          { shop: shopDomain, orderId, countCode },
          "Payments reconciled against the MetaKocka document",
        );
      } catch (error) {
        await prisma.metakockaDocument.update({
          where: { id: claim!.id },
          data: {
            mkStatus: "payment refused",
            responseBody:
              error instanceof MetakockaError
                ? { oprCode: error.oprCode, oprDesc: error.oprDesc }
                : { error: String(error) },
          },
        });

        if (error instanceof MetakockaError && error.kind === "exception") {
          await raiseException(principal, {
            orderId,
            kind: "payment_write_failed",
            message: `MetaKocka refused the payment for ${documentLabel}. ${describeForMerchant(error)} The sales order itself is unchanged. Record the payment in MetaKocka by hand or fix the cause and retry.`,
            detail: { countCode, sentCountCode, oprCode: error.oprCode },
          });
          return;
        }
        throw error;
      }
      return;
    }

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
        message: `Order ${order!.shopifyOrderNumber} has changed in Shopify since ${documentLabel} was sent, and the MetaKocka document was not updated because ${blocked}. Correct it in MetaKocka by hand, or change this on the Sales orders settings page.`,
        detail: { countCode, sentCountCode, reason: blocked },
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

      // The replacement carried the payments with it, so what the ERP holds
      // and what this app records have to move together.
      await recordDocumentPaymentState(claim!.id, desiredPayment, new Date());
      await touchDocumentReconciled(claim!.id, new Date());

      // Nothing to move for an unsplit order: it has no allocation rows,
      // because it was never allocated to a warehouse.
      if (source) {
        await prisma.allocation.updateMany({
          where: { supplySourceId, orderLine: { orderId } },
          data: { status: "written_to_metakocka" },
        });
      }

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
          source: sourceLabel,
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
          message: `Order ${order!.shopifyOrderNumber} changed in Shopify, and MetaKocka refused the update to ${documentLabel}. ${describeForMerchant(error)} The document is unchanged. Correct it in MetaKocka by hand.`,
          detail: { countCode, sentCountCode, oprCode: error.oprCode },
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

    /*
     * Is the document MetaKocka answered with ours?
     *
     * When this app chose the number, the answer is exactly whether the numbers
     * match, and a sibling answering is "could not tell" (§3: which of several
     * documents sharing a `buyer_order` answers is not documented).
     *
     * When **MetaKocka** chose it there is no number of ours to compare — so
     * the question is answered structurally instead. An unsplit order has one
     * document and only one, so anything found under its reference is that
     * document. A split order does not have that guarantee, and guessing would
     * risk adopting a sibling's `mk_id` as this document's, so it stops and
     * asks. That is the honest cost of handing numbering to the ERP, and it is
     * paid only by a write whose outcome was already unknown.
     */
    const isOurs = sentCountCode
      ? found.countCode === sentCountCode
      : wholeOrder;

    if (isOurs) {
      await recordDocumentResult(claim!.id, {
        status: "written",
        mkId: found.mkId,
        // Same as a fresh write: adopt the number MetaKocka is holding it under.
        ...(sentCountCode
          ? {}
          : { sentCountCode: found.countCode ?? found.docNumber }),
        responseBody: {
          recovered: true,
          mkId: found.mkId,
          docNumber: found.docNumber,
        },
      });

      // Nothing to move for an unsplit order: it has no allocation rows,
      // because it was never allocated to a warehouse.
      if (source) {
        await prisma.allocation.updateMany({
          where: { supplySourceId, orderLine: { orderId } },
          data: { status: "written_to_metakocka" },
        });
      }

      await closeExceptionsFor(principal, orderId, [...WRITE_FAILURE_KINDS]);

      // The body that landed carried `mark_paid`, and MetaKocka confirms a
      // payment on the document — record it so `mark-metakocka-paid` does not
      // send a second one (§8.7: exactly once). When MetaKocka does not
      // confirm one, nothing is recorded: the later payment path then records
      // it properly, and re-marking an identical payment is the harmless
      // direction to be wrong in.
      if (found.hasPayment === true) {
        await recordDocumentPaymentState(claim!.id, desiredPayment, new Date());
      }

      await appendEvent(principal, {
        entityType: "order",
        entityId: orderId,
        event: "order.document_recovered",
        detail: {
          countCode,
          mkId: found.mkId,
          source: sourceLabel,
          reason:
            "an earlier attempt had no recorded outcome, and the document was found in MetaKocka by its order reference",
        },
      });

      await markOrderWrittenIfComplete(orderId, { wholeOrder });

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
      message: sentCountCode
        ? `An earlier attempt to send ${sentCountCode} to MetaKocka got no answer, so it may or may not exist there — and because this order has more than one document, the lookup could not tell. Check in MetaKocka whether a sales order ${sentCountCode} exists: if it does not, retry this order; if it does, mark this as resolved.`
        : `An earlier attempt to send part of order ${order!.shopifyOrderNumber} to MetaKocka got no answer, so it may or may not exist there. MetaKocka numbers this shop's sales orders itself, so this app has no number of its own to look for, and the document it found under ${order!.customerOrderRef} (${found.countCode ?? "unnumbered"}) belongs to one of the order's warehouses without saying which. Check in MetaKocka which of this order's sales orders exist: if one is missing, retry this order; if they are all there, mark this as resolved.`,
      detail: {
        countCode,
        sentCountCode,
        answeredCountCode: found.countCode,
      },
    });

    if (source) {
      await prisma.allocation.updateMany({
        where: { supplySourceId, orderLine: { orderId } },
        data: { status: "failed" },
      });
    }
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
      /*
       * The number MetaKocka chose, when this app sent none.
       *
       * Recorded from its own answer rather than assumed, and this is what
       * makes the setting safe past the first write: every later update sends
       * the same number back — rather than omitting the field and relying on
       * behaviour §3 has not verified — and every message about the document
       * names something the merchant can find on their screen. `count_code`
       * first because that is the field MetaKocka's own form labels *Sales ord.
       * no.*; `doc_number` is the fallback for a response that names only that.
       */
      ...(sentCountCode
        ? {}
        : { sentCountCode: result.countCode ?? result.docNumber }),
      requestBody: body,
      responseBody: result,
    });

    if (source) {
      await prisma.allocation.updateMany({
        where: { supplySourceId, orderLine: { orderId } },
        data: { status: "written_to_metakocka" },
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
        source: sourceLabel,
        isPrimary,
        lines: perSourceLines.length,
      },
    });

    // Records what was paid, not only that it was: a split order pays each
    // document its own share, and the shares have to be shown to add up.
    // Under the ledger this also writes one `order_payment_application` per
    // receipt, which is what lets the §24 invariant compare what MetaKocka was
    // told against what Shopify says was received.
    await recordDocumentPaymentState(claim.id, desiredPayment, new Date());

    // Once every source the allocation names has a written document, the
    // order is done. Measured against the allocation, not against the rows
    // that happen to exist (see markOrderWrittenIfComplete).
    await markOrderWrittenIfComplete(orderId, { wholeOrder });

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
        detail: {
          countCode,
          sentCountCode,
          source: sourceLabel,
          oprCode: error.oprCode,
        },
      });

      if (source) {
        await prisma.allocation.updateMany({
          where: { supplySourceId, orderLine: { orderId } },
          data: { status: "failed" },
        });
      }
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

/* -------------------------------------------------------------------------- */
/* Payments on one document                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a document should carry in `mark_paid`, from whichever source knows.
 *
 * `ledger` is the reconciled answer — individual Shopify transactions allocated
 * across this order's documents — and it is the one this app uses whenever a
 * ledger exists. `legacy` is the pre-ledger behaviour, derived from Shopify's
 * `financial_status`, kept for orders with no transactions recorded at all.
 */
export type DesiredPayment =
  | { kind: "ledger"; payments: DocumentPayment[]; entries: PaymentPlanEntry[] }
  | {
      kind: "legacy";
      payment: { paymentType: string; paidAt: Date; amountMinor: number } | null;
    };

async function desiredPaymentsFor(
  principal: Principal,
  input: {
    orderId: string;
    supplySourceId: string;
    share: DocumentShare | undefined;
    given: { payments: DocumentPayment[]; entries: PaymentPlanEntry[] } | undefined;
    order: { paymentGateway: string | null; financialStatus: string; receivedAt: Date };
    parsed: { gateway: string | null } | null;
  },
): Promise<DesiredPayment> {
  const settings = await getSalesOrderSettings(principal);

  /*
   * Payments turned off entirely.
   *
   * An empty ledger rather than "no opinion": on an update that clears whatever
   * `mark_paid` the document had, which is what a merchant who has just turned
   * payment sync off is asking for. It does not delete anything else.
   */
  if (!settings.syncPayments) return { kind: "ledger", payments: [], entries: [] };

  // The reconciler already divided the order's ledger. Nothing to re-derive.
  if (input.given) {
    return {
      kind: "ledger",
      payments: input.given.payments,
      entries: input.given.entries,
    };
  }

  /*
   * No share means this source is not in the current allocation — a document
   * left behind by a warehouse move. It gets no payment, and the fallback that
   * used to be here is why: falling back to the order total paid the *whole
   * order* against a document that no longer describes any of it.
   */
  if (!input.share) return { kind: "ledger", payments: [], entries: [] };

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { totalMinor: true },
  });

  const ledger = await readLedger(
    principal,
    input.orderId,
    order?.totalMinor ?? 0,
  );

  /*
   * Nothing in the ledger at all.
   *
   * Not "nothing was paid" — an order from before this feature, or one whose
   * transactions could not be read, looks exactly the same. Guessing from
   * `financial_status` is worse than the ledger and much better than leaving a
   * paid order unpaid in the ERP for ever, so the old path answers.
   */
  if (ledger.rows.length === 0) {
    return {
      kind: "legacy",
      payment: await resolvePayment(principal, {
        orderId: input.orderId,
        gateway: input.order.paymentGateway ?? input.parsed?.gateway ?? null,
        financialStatus: input.order.financialStatus,
        paidAt: input.order.receivedAt,
        amountMinor: input.share.totalMinor,
      }),
    };
  }

  const shares = await computeDocumentShares(input.orderId);
  const documents = await listDocumentsForReconciliation(principal, input.orderId);

  const plan = await planPayments(principal, {
    ledger,
    shares,
    retiredSourceIds: new Set(
      documents
        .filter((document) => document.retiredAt !== null && document.supplySourceId)
        .map((document) => document.supplySourceId!),
    ),
    countCodeBySource: new Map(
      documents
        .filter((document) => document.supplySourceId)
        .map((document) => [document.supplySourceId!, document.countCode]),
    ),
    strategy: settings.paymentAllocation,
    entryMode: settings.paymentEntryMode,
    fallbackPaidAt: input.order.receivedAt,
  });

  const mine = plan.bySource.get(input.supplySourceId);
  return {
    kind: "ledger",
    payments: mine?.payments ?? [],
    entries: mine?.entries ?? [],
  };
}

/**
 * Writes down what the document now carries, on both sides of the ledger join.
 *
 * `payment_marked_at` keeps its original meaning — "a payment is recorded
 * against this document" — and is **cleared** when the desired set is empty.
 * That is not tidiness: a document whose receipt was reallocated after a
 * warehouse move would otherwise go on counting as paid, and the order would
 * read as paid twice.
 */
async function recordDocumentPaymentState(
  documentId: string,
  desired: DesiredPayment,
  at: Date,
): Promise<void> {
  if (desired.kind === "legacy") {
    if (!desired.payment) return;
    await recordPaymentMark(documentId, {
      at,
      paymentType: desired.payment.paymentType,
      amountMinor: desired.payment.amountMinor,
    });
    return;
  }

  const totalMinor = desired.payments.reduce(
    (total, entry) => total + entry.amountMinor,
    0,
  );

  await recordDocumentPayments(documentId, {
    at: desired.payments.length > 0 ? at : null,
    // One type when they agree, otherwise the fact that they do not — a
    // deposit by transfer and a balance by card is a real order.
    paymentType:
      desired.payments.length === 0
        ? null
        : new Set(desired.payments.map((entry) => entry.paymentType)).size === 1
          ? desired.payments[0]!.paymentType
          : "mixed",
    amountMinor: totalMinor,
  });

  // Only recorded as applied for entries whose identity is known; the
  // reconciler-supplied path passes entries, the derived path does too.
  await replaceApplicationsForDocument(
    documentId,
    desired.entries.map((entry) => ({
      orderPaymentId: entry.orderPaymentId,
      documentId,
      amountMinor: entry.amountMinor,
      paymentType: entry.paymentType,
      appliedAt: at,
    })),
  );
}

/**
 * What a document body says about the *order*, with everything that is not the
 * order removed.
 *
 * `mark_paid` is out because a payment arriving is the payment path doing its
 * job rather than the order having changed, and conflating the two put the
 * merchant's update policy in front of every second capture.
 *
 * `count_code` is out for a different reason, and without it a shop that lets
 * MetaKocka number its documents would rewrite every one of them exactly once.
 * Such a document is created with no number, MetaKocka answers with one, and it
 * is recorded — so the *next* body legitimately carries a `count_code` the
 * first did not, and a content comparison would read the ERP's own answer as a
 * change to the order. It is not one: the number is settled at claim time and
 * frozen thereafter, so it can never differ from what the document already
 * holds in a way an update should chase.
 */
export function contentOnly(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const {
    mark_paid: _payments,
    count_code: _number,
    ...rest
  } = body as Record<string, unknown>;
  return rest;
}

/** Just the payments of a document body, for comparing those alone. */
export function paymentsOf(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (body as Record<string, unknown>).mark_paid ?? null;
}
