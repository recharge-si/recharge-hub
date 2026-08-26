import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import {
  applyOrderSync,
  getOrderDetail,
  listAllocatableSources,
  productsForSkus,
  savePartnerOverride,
  setManualAllocations,
  UnknownSupplySourceError,
  stockForOrder,
} from "~/adapters/db/repositories/order.server";
import { metakockaDocumentUrl } from "~/adapters/metakocka/documents";
import { redriveOrder } from "~/adapters/queue/redrive.server";
import {
  partnerOverrideSchema,
  parsePartnerOverride,
} from "~/domain/orders/partner";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { closeExceptionsFor } from "~/adapters/db/repositories/exception.server";
import { parseOrderSafe } from "~/adapters/shopify/order-payload";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { Dropdown } from "~/web/components/dropdown";
import { formatDateTime } from "~/web/lib/datetime";
import { describeExceptionKind } from "~/web/lib/exceptions";
import { formatMoney } from "~/web/lib/money";
import {
  describePayment,
  describeProgress,
  formatTaxRate,
} from "~/web/lib/orders";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * One order, and why it went where it went.
 *
 * This page is the decision trail §13 asks the M4 demo to produce: an order for
 * 8 units where own stock is 5 splits 5/3, lands as two MetaKocka documents
 * whose totals sum to the Shopify total, "and the audit log explains why". The
 * reason recorded on each allocation is shown next to it, in the merchant's
 * words, because "why is this line coming from the partner" is the question the
 * whole app exists to answer.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const order = await getOrderDetail(principal, params.orderId ?? "");
  if (!order) throw new Response("Order not found", { status: 404 });

  // Both only exist so the two things that used to be impossible on this page
  // are possible: choosing a source by hand, and giving MetaKocka a customer
  // for an order Shopify has no address on.
  const [sources, stock, products] = await Promise.all([
    listAllocatableSources(principal),
    stockForOrder(principal, order.id),
    /*
     * The picture and the MetaKocka match for the SKUs on this order.
     *
     * The registry already holds them from the catalogue read, and this is
     * where they earn their place: a line that cannot be sent because MetaKocka
     * has no product with that code is the commonest reason an order stops, and
     * "P04200014480" tells nobody which product that is.
     */
    productsForSkus(
      principal,
      order.lines.map((line) => line.sku),
    ),
  ]);

  const override = parsePartnerOverride(order.partnerOverride);

  // Parsed once. Past the 90-day redaction there is no payload left, which
  // reads here as "Shopify has no address" — and by then it is true of anything
  // this app could send.
  const shopifyParty = parseOrderSafe(order.rawPayload);

  return {
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      code: source.code,
      kind: source.kind,
    })),
    partnerOverride: override,
    /** Whether Shopify gave us anything to file the order against at all. */
    hasShopifyAddress: Boolean(
      shopifyParty?.partner ?? shopifyParty?.receiver,
    ),
    order: {
      id: order.id,
      number: order.shopifyOrderNumber,
      reference: order.customerOrderRef,
      status: order.status,
      financialStatus: order.financialStatus,
      paymentGateway: order.paymentGateway,
      lastSyncedAt: order.lastSyncedAt?.toISOString() ?? null,
      divergedAt: order.divergedAt?.toISOString() ?? null,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      currency: order.presentmentCurrency,
      totalMinor: order.totalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
      receivedAt: order.receivedAt.toISOString(),
      redacted: order.rawPayload === null,
      allocationLockedAt: order.allocationLockedAt?.toISOString() ?? null,
      lines: order.lines.map((line) => ({
        id: line.id,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
        taxFactor: line.taxFactor,
        // What each source has for this SKU, so the picker is an informed
        // choice rather than a guess.
        stock: [...(stock.get(line.sku)?.entries() ?? [])].map(
          ([sourceId, free]) => ({ sourceId, free }),
        ),
        imageUrl: products.get(line.sku)?.imageUrl ?? null,
        inMetakocka: products.get(line.sku)?.matched ?? false,
        /*
         * The product as Shopify has it now, falling back to what was stored
         * with the order.
         *
         * The registry is refreshed by the catalogue sync and keeps the title
         * and the option values apart; `order_line.title` is whatever Shopify
         * sent the day the order arrived, which is the right thing to keep but
         * the wrong thing to read a hundred rows of.
         */
        productTitle: products.get(line.sku)?.title ?? line.title,
        variantTitle: products.get(line.sku)?.variantTitle ?? null,
        allocations: line.allocations.map((allocation) => ({
          id: allocation.id,
          quantity: allocation.quantity,
          status: allocation.status,
          sourceId: allocation.supplySourceId,
          sourceName: allocation.supplySource?.name ?? null,
          reason:
            (allocation.reason as { detail?: string } | null)?.detail ?? null,
        })),
      })),
      documents: order.documents.map((document) => ({
        id: document.id,
        countCode: document.countCode,
        mkId: document.mkId,
        status: document.status,
        isPrimary: document.isPrimary,
        sourceName: document.supplySource?.name ?? null,
        mkStatus: document.mkStatus,
        // A link straight to the document in MetaKocka's own interface, so
        // "let me look at the actual thing" does not mean copying a reference
        // and searching for it.
        metakockaUrl: document.mkId ? metakockaDocumentUrl(document.mkId) : null,
        mkDocNumber: document.mkDocNumber,
        mkCheckedAt: document.mkCheckedAt?.toISOString() ?? null,
        paymentMarkedAt: document.paymentMarkedAt?.toISOString() ?? null,
        paymentType: document.paymentType,
        paymentAmountMinor: document.paymentAmountMinor,
      })),
      exceptions: order.exceptions.map((exception) => ({
        id: exception.id,
        kind: exception.kind,
        message: exception.message,
        status: exception.status,
        createdAt: exception.createdAt.toISOString(),
      })),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const orderId = params.orderId ?? "";

  const order = await getOrderDetail(principal, orderId);
  if (!order) return { ok: false, message: "That order no longer exists." };

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "reallocate") {
    // Through the shared re-drive, which also releases a hand-made allocation:
    // asking the app to choose again is the merchant changing their mind, and
    // the lock exists to stop background jobs doing it, not them.
    await redriveOrder(principal, orderId, "allocate");
    return {
      ok: true,
      message:
        "Allocating again in the background. Reload this page in a moment to see the result.",
    };
  }

  if (intent === "retry-metakocka") {
    const sourceIds = [
      ...new Set(
        order.lines.flatMap((line) =>
          line.allocations
            .map((allocation) => allocation.supplySourceId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ];

    for (const sourceId of sourceIds) {
      await enqueue(
        QUEUES.writeMetakockaOrder,
        { shopDomain: session.shop, orderId, supplySourceId: sourceId },
        { singletonKey: `mk:${orderId}:${sourceId}:retry:${Date.now()}` },
      );
    }

    return {
      ok: true,
      message:
        sourceIds.length === 0
          ? "There is nothing allocated to send yet."
          : "Sending to MetaKocka again in the background.",
    };
  }

  if (intent === "save-partner") {
    /*
     * Customer details for an order Shopify has no address on.
     *
     * MetaKocka refuses a sales order without a partner, and the only advice
     * this app could give was "add the address in Shopify and retry" — which is
     * not always possible, and left the merchant pressing a retry button that
     * could not succeed. Entering it here is the same information by a route
     * that exists.
     */
    const parsed = partnerOverrideSchema.safeParse({
      customer: formData.get("customer") ?? "",
      street: formData.get("street") || null,
      postNumber: formData.get("postNumber") || null,
      place: formData.get("place") || null,
      country: formData.get("country") || null,
      taxNumber: formData.get("taxNumber") || null,
      email: formData.get("email") || null,
      phone: formData.get("phone") || null,
      isBusiness: formData.get("isBusiness") === "on",
    });

    if (!parsed.success) {
      // §2.8: say what is wrong and how to fix it, never just "invalid".
      return {
        ok: false,
        message:
          "A customer or company name is required. MetaKocka will not accept a sales order without one.",
      };
    }

    await savePartnerOverride(principal, orderId, parsed.data);

    const { queued } = await redriveOrder(principal, orderId, "write");

    return {
      ok: true,
      message: queued.length
        ? `Saved, and ${queued.join(", ")}.`
        : "Saved. These details are used the next time this order is sent.",
    };
  }

  if (intent === "clear-partner") {
    await savePartnerOverride(principal, orderId, null);
    return {
      ok: true,
      message:
        "Removed. This order falls back to the address Shopify holds, if there is one.",
    };
  }

  if (intent === "allocate-by-hand") {
    /*
     * "Choose a source by hand, or restock and retry."
     *
     * The exceptions queue has been giving that advice since the beginning with
     * nowhere to act on it. This is the somewhere. It exists for the case
     * automatic allocation cannot answer — the stock figures say no and the
     * merchant knows something the figures do not — so it deliberately does not
     * check stock before accepting the choice.
     */
    const records = order.lines.flatMap((line) => {
      const sourceId = String(formData.get(`source:${line.id}`) ?? "");
      if (!sourceId) return [];

      const raw = Number(formData.get(`quantity:${line.id}`) ?? line.quantity);
      const quantity =
        Number.isFinite(raw) && raw > 0
          ? Math.min(Math.floor(raw), line.quantity)
          : line.quantity;

      return [{ orderLineId: line.id, supplySourceId: sourceId, quantity }];
    });

    if (records.length === 0) {
      return {
        ok: false,
        message:
          "Choose a supply source for at least one line, or use “Allocate again” to let the app decide.",
      };
    }

    try {
      await setManualAllocations(
        principal,
        orderId,
        records,
        session.shop,
        new Date(),
      );
    } catch (error) {
      // Only a forged post gets here — the picker is scoped to this shop — but
      // §2.8 wants an answer next to the field, not a stack trace.
      if (error instanceof UnknownSupplySourceError) {
        return {
          ok: false,
          message:
            "One of the chosen supply sources is not set up on this store. Reload the page and choose again.",
        };
      }
      throw error;
    }

    const { queued } = await redriveOrder(principal, orderId, "write");

    return {
      ok: true,
      message: `Set ${records.length === 1 ? "one line" : `${records.length} lines`} by hand${queued.length ? `, ${queued.join(", ")}` : ""}. The app will not change this on its own — use "Allocate again" to hand it back.`,
    };
  }

  if (intent === "check-shopify") {
    /*
     * Ask Shopify what this order is now.
     *
     * The same read the reconciler does, on demand. It exists because a
     * merchant who has just changed something in Shopify should not have to
     * wait a quarter of an hour to see whether this app agreed with it — and
     * because when something does go wrong with a webhook, this is the button
     * that proves it.
     */
    await enqueue(
      QUEUES.syncOrderState,
      { shopDomain: session.shop, shopifyOrderId: order.shopifyOrderId },
      { singletonKey: `refresh:${session.shop}:${order.shopifyOrderId}` },
    );
    return {
      ok: true,
      message:
        "Reading this order back from Shopify. Reload the page in a moment to see what changed.",
    };
  }

  if (intent === "record-payment") {
    await enqueue(
      QUEUES.markMetakockaPaid,
      { shopDomain: session.shop, orderId },
      { singletonKey: `paid:${orderId}:retry:${Date.now()}` },
    );
    return {
      ok: true,
      message:
        "Recording the payment in MetaKocka in the background. A document that is already paid is left alone.",
    };
  }

  if (intent === "accept-shopify") {
    /*
     * The merchant is saying they have dealt with the difference in MetaKocka.
     *
     * Until somebody says so, a divergence is reported on every pass — it is
     * still true, and resolving the exception alone would not make it false.
     * This is what settles it: the stored lines and totals are brought up to
     * Shopify's version, so the next comparison finds nothing.
     *
     * **It changes nothing in MetaKocka**, and the copy says so rather than
     * letting the button read as "make this go away". Only the merchant knows
     * what they did in the ERP, and this app will not guess at an accounting
     * correction — nor write a second document, which is the only other thing
     * it could do and would leave the order invoiced twice.
     *
     * The document poller is the backstop: it compares MetaKocka against what
     * was actually sent, so a document edited there still surfaces afterwards.
     */
    /*
     * `parseOrderSafe`, not `parseOrder`. The §2.4 retention job does not
     * clear `raw_payload` — it overwrites the personal fields *in place* with
     * the string "[redacted]", so the column is still there and a schema
     * expecting an object throws on it. A 500 on this button is the worst
     * possible answer: the merchant is told nothing, and the divergence they
     * have already dealt with stays on the queue for ever.
     */
    const parsed = parseOrderSafe(order.rawPayload);
    if (!parsed) {
      return {
        ok: false,
        message:
          "The details of this order have been removed under the 90-day retention policy, so there is nothing left to compare against.",
      };
    }

    await applyOrderSync(principal, orderId, {
      parsed,
      rawPayload: order.rawPayload,
      replaceLines: true,
      diverged: false,
      now: new Date(),
    });
    await closeExceptionsFor(principal, orderId, ["order_diverged"]);

    await appendEvent(principal, {
      entityType: "order",
      entityId: orderId,
      event: "order.difference_accepted",
      detail: { by: session.shop },
    });

    return {
      ok: true,
      message:
        "This order now reads as Shopify has it, and the difference will not be reported again. Nothing was sent to MetaKocka — if the document there still holds the older figures, correct it in MetaKocka.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

export default function OrderDetail() {
  const { order, sources, partnerOverride, hasShopifyAddress } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  /*
   * The hand-made allocation, held in state.
   *
   * Seeded from what is already allocated so the picker opens showing the
   * app's own answer rather than empty — the merchant is usually changing one
   * line, not filling in a blank form.
   */
  const [picked, setPicked] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [
        line.id,
        line.allocations.find((allocation) => allocation.sourceId)?.sourceId ??
          "",
      ]),
    ),
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(order.lines.map((line) => [line.id, line.quantity])),
  );
  /*
   * Reading and editing are the same table.
   *
   * A separate "choose a source" section meant the whole order was printed
   * twice, and the page grew by its own length the moment anyone wanted to
   * change one line.
   */
  const [editingSources, setEditingSources] = useState(false);

  // The lines whose allocation is worth explaining: split across sources, or
  // not fully covered by one.
  const splitLines = order.lines.filter(
    (line) =>
      line.allocations.length > 1 ||
      line.allocations.some(
        (allocation) =>
          !allocation.sourceName || allocation.quantity !== line.quantity,
      ),
  );

  const openExceptions = order.exceptions.filter(
    (exception) => exception.status === "open",
  );

  const written = order.documents.filter(
    (document) => document.status === "written",
  );
  // Only offered when there is something to do: an order Shopify calls paid
  // with a document in MetaKocka that does not say so.
  const allDocumentsPaid =
    written.length > 0 &&
    written.every((document) => document.paymentMarkedAt !== null);

  return (
    <s-page heading={`Order ${order.number}`}>
      <s-link slot="breadcrumb-actions" href="/app/orders">
        Orders
      </s-link>

      <s-stack direction="block" gap="large">
        {result ? (
          <s-banner
            tone={result.ok ? "info" : "critical"}
            heading={result.ok ? "Queued" : "That did not work"}
          >
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {openExceptions.map((exception) => (
          <s-banner
            key={exception.id}
            tone="critical"
            heading={describeExceptionKind(exception.kind).label}
          >
            <s-paragraph>{exception.message}</s-paragraph>
          </s-banner>
        ))}

        <s-section heading="Summary">
          <s-stack direction="block" gap="base">
            {/*
             * The same two badges the list shows, from the same table, so an
             * order does not change vocabulary when it is opened.
             */}
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge tone={describeProgress(order.status).tone}>
                {describeProgress(order.status).label}
              </s-badge>
              <s-badge tone={describePayment(order.financialStatus).tone}>
                {describePayment(order.financialStatus).label}
              </s-badge>
            </s-stack>

            <s-text color="subdued">
              {`Received ${formatDateTime(order.receivedAt)}. MetaKocka reference ${order.reference}.`}
            </s-text>

            {/*
              * Where the payment state came from and when it was last checked.
              *
              * Shopify webhooks are best-effort, so "this app believes the
              * order is unpaid" and "the order is unpaid" are different
              * statements. Saying when the two were last compared is what makes
              * the first one trustworthy.
              */}
            <s-text color="subdued">
              {[
                order.paymentGateway
                  ? `Paid through ${order.paymentGateway}.`
                  : null,
                order.lastSyncedAt
                  ? `Last checked against Shopify ${formatDateTime(order.lastSyncedAt)}.`
                  : "Not checked against Shopify since it arrived.",
              ]
                .filter(Boolean)
                .join(" ")}
            </s-text>

            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Order total</s-text>
                <s-text type="strong">
                  {formatMoney(order.totalMinor, order.currency)}
                </s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Shipping</s-text>
                <s-text>
                  {formatMoney(order.shippingMinor, order.currency)}
                </s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Discount</s-text>
                <s-text>
                  {formatMoney(order.discountMinor, order.currency)}
                </s-text>
              </s-stack>
            </s-grid>

            {order.redacted ? (
              <s-text color="subdued">
                The customer details for this order have been redacted under the
                90-day retention policy. The decision trail below is kept.
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        {/*
          * The lines, as a table.
          *
          * This was a stack of cards, each with a full-width grey block under
          * it spelling out which rule fired. On a four-line order that read as
          * thorough; on a hundred-line order it was three hundred lines of page
          * and the order itself became unreadable.
          *
          * `variant="auto"` is what makes a table safe here: Polaris turns the
          * columns into a labelled list at 375px rather than letting the page
          * scroll sideways (§2.6).
          */}
        {/*
          * The lines, and where each one comes from — one table, two modes.
          *
          * Choosing a source by hand used to be a second section below this
          * one: every line listed again, each with a labelled dropdown and a
          * quantity field. That is the whole order printed twice, and on an
          * order with a hundred lines it is unusable in both halves.
          *
          * So the picker lives in the column that already shows the answer.
          * Reading and changing are the same table, the merchant never loses
          * their place, and the page does not grow when they decide to edit.
          *
          * `variant="auto"` is what makes a table safe here: Polaris turns the
          * columns into a labelled list at 375px rather than letting the page
          * scroll sideways (§2.6).
          */}
        <s-section heading="Lines and where they are fulfilled from">
          <Form method="post">
            <input type="hidden" name="intent" value="allocate-by-hand" />

            <s-stack direction="block" gap="base">
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-text color="subdued">
                  {editingSources
                    ? "Set the source for a line yourself. Use this when the stock figures are wrong or out of date — the app does not check them here."
                    : order.allocationLockedAt
                      ? `Chosen by hand ${formatDateTime(order.allocationLockedAt)}. The app will not change these on its own.`
                      : "Chosen automatically from stock and priority."}
                </s-text>

                {editingSources ? (
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      type="button"
                      variant="tertiary"
                      onClick={() => setEditingSources(false)}
                    >
                      Cancel
                    </s-button>
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(busy ? { disabled: true } : {})}
                    >
                      Set sources and send
                    </s-button>
                  </s-stack>
                ) : (
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditingSources(true)}
                  >
                    Change sources
                  </s-button>
                )}
              </s-stack>

              {/*
                * One choice for the whole order.
                *
                * The overwhelming case is every line coming from the same
                * place, and on a hundred-line order picking it a hundred times
                * is asking the merchant to do the app's typing. Only offered
                * when there is more than one line to apply it to.
                */}
              {editingSources && order.lines.length > 1 ? (
                <s-stack
                  direction="inline"
                  gap="small-300"
                  alignItems="end"
                >
                  <s-box minInlineSize="260px">
                    <Dropdown
                      name="apply-all"
                      label="Set every line to"
                      placeholder="Choose a source"
                      value=""
                      options={sources.map((source) => ({
                        value: source.id,
                        label: source.name,
                      }))}
                      onChange={(value) =>
                        setPicked(
                          Object.fromEntries(
                            order.lines.map((line) => [line.id, value]),
                          ),
                        )
                      }
                    />
                  </s-box>
                </s-stack>
              ) : null}

              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="kicker">SKU</s-table-header>
                  <s-table-header listSlot="labeled">Tax</s-table-header>
                  <s-table-header listSlot="inline">From</s-table-header>
                  <s-table-header listSlot="labeled">Quantity</s-table-header>
                  <s-table-header listSlot="secondary" format="currency">
                    Price
                  </s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {order.lines.map((line) => (
                    <s-table-row key={line.id}>
                      <s-table-cell>
                        <s-stack
                          direction="inline"
                          gap="small-300"
                          alignItems="center"
                        >
                          {/*
                            * The box holds the space, the image fills it.
                            * `s-image` takes only `fill` or `auto` for its
                            * inline size, and `auto` would let a 2000px product
                            * photo decide the column width. Sized either way so
                            * a hundred rows with mixed imagery do not shift the
                            * page as they load (§2.5).
                            */}
                          <s-box inlineSize="40px" blockSize="40px">
                            {line.imageUrl ? (
                              <s-image
                                src={line.imageUrl}
                                alt=""
                                inlineSize="fill"
                                objectFit="contain"
                                loading="lazy"
                              />
                            ) : null}
                          </s-box>

                          <s-stack direction="block" gap="small-500">
                            <s-text>{line.productTitle}</s-text>
                            {/*
                              * The option values, on their own line. What it
                              * is, then which one of it — the order a merchant
                              * reads a line in.
                              */}
                            {line.variantTitle ? (
                              <s-text color="subdued">
                                {line.variantTitle}
                              </s-text>
                            ) : null}
                            {line.sku && !line.inMetakocka ? (
                              <s-badge tone="warning">Not in MetaKocka</s-badge>
                            ) : null}
                          </s-stack>
                        </s-stack>
                      </s-table-cell>

                      <s-table-cell>
                        <s-text color="subdued">{line.sku || "No SKU"}</s-text>
                      </s-table-cell>

                      <s-table-cell>
                        {/*
                          * A rate, not a factor. "0.22" is the number sent to
                          * MetaKocka; 22% is the number the merchant knows.
                          */}
                        <s-text>{formatTaxRate(line.taxFactor)}</s-text>
                      </s-table-cell>

                      <s-table-cell>
                        {editingSources ? (
                          <s-stack
                            direction="inline"
                            gap="small-500"
                            alignItems="end"
                          >
                            <s-box minInlineSize="200px">
                              <Dropdown
                                name={`source:${line.id}`}
                                label="Supply source"
                                hideLabel
                                placeholder="Leave to the app"
                                value={picked[line.id] ?? ""}
                                onChange={(value) =>
                                  setPicked((current) => ({
                                    ...current,
                                    [line.id]: value,
                                  }))
                                }
                                options={[
                                  { value: "", label: "Leave to the app" },
                                  ...sources.map((source) => {
                                    const free =
                                      line.stock.find(
                                        (entry) => entry.sourceId === source.id,
                                      )?.free ?? 0;
                                    return {
                                      value: source.id,
                                      // The stock is in the label because it is
                                      // the fact the decision turns on, and a
                                      // merchant should not have to open
                                      // another page to see that the source
                                      // they are about to pick has none.
                                      label: `${source.name} — ${free} free`,
                                    };
                                  }),
                                ]}
                              />
                            </s-box>

                            {/*
                              * A quantity field only where it can mean
                              * something. A line of one cannot be split, and a
                              * box reading "1" that will always read "1" is a
                              * field to skip past on every row.
                              */}
                            {line.quantity > 1 ? (
                              <s-box inlineSize="90px">
                                <s-number-field
                                  name={`quantity:${line.id}`}
                                  label="Quantity"
                                  labelAccessibilityVisibility="exclusive"
                                  min={1}
                                  max={line.quantity}
                                  value={String(
                                    quantities[line.id] ?? line.quantity,
                                  )}
                                  onChange={(event) =>
                                    setQuantities((current) => ({
                                      ...current,
                                      [line.id]: Number(
                                        event.currentTarget.value,
                                      ),
                                    }))
                                  }
                                />
                              </s-box>
                            ) : null}
                          </s-stack>
                        ) : line.allocations.length === 0 ? (
                          <s-badge tone="warning">Not allocated</s-badge>
                        ) : (
                          <s-stack
                            direction="inline"
                            gap="small-500"
                            alignItems="center"
                          >
                            {line.allocations.map((allocation) => (
                              <s-badge
                                key={allocation.id}
                                tone={
                                  allocation.sourceName ? "success" : "critical"
                                }
                              >
                                {allocation.sourceName
                                  ? // The count only when it is not the whole
                                    // line: "Glavno 2" says something, "Glavno
                                    // 1 of 1" says it twice.
                                    allocation.quantity === line.quantity
                                    ? allocation.sourceName
                                    : `${allocation.sourceName} ${allocation.quantity}`
                                  : `Needs a decision (${allocation.quantity})`}
                              </s-badge>
                            ))}
                          </s-stack>
                        )}
                      </s-table-cell>

                      <s-table-cell>{String(line.quantity)}</s-table-cell>

                      <s-table-cell>
                        {formatMoney(
                          line.unitPriceWithTaxMinor,
                          order.currency,
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>

              {/*
                * The decision trail, only where it is not obvious.
                *
                * §13 asks this page to explain why a line went where it went,
                * and it does — for the lines where that is a question. A line
                * taken whole from the one warehouse that had it needs no
                * explanation, and printing one for every such line is what
                * buried the ones that do.
                */}
              {!editingSources && splitLines.length > 0 ? (
                <s-stack direction="block" gap="small-400">
                  <s-text type="strong">Why these lines were split</s-text>
                  {splitLines.flatMap((line) =>
                    line.allocations
                      .filter((allocation) => allocation.reason)
                      .map((allocation) => (
                        <s-text key={allocation.id} color="subdued">
                          {`${line.sku || line.productTitle} — ${
                            allocation.sourceName ?? "unallocated"
                          }: ${allocation.reason}`}
                        </s-text>
                      )),
                  )}
                </s-stack>
              ) : null}
            </s-stack>
          </Form>
        </s-section>


        {/*
          * Customer details, for an order Shopify has no address on.
          *
          * Point-of-sale orders, digital goods and some draft orders arrive
          * with neither a billing nor a shipping address, and MetaKocka refuses
          * a sales order without a partner. The only thing this app could say
          * was "add the address in Shopify and retry", which is sometimes
          * impossible and always slower than typing it here.
          *
          * Shown when it is needed or when it has been used, and stays out of
          * the way otherwise: most orders have an address and this section
          * would be one more thing to read past.
          */}
        {!hasShopifyAddress || partnerOverride ? (
          <s-section heading="Customer details for MetaKocka">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {hasShopifyAddress
                  ? "These details are used instead of the address Shopify holds."
                  : "Shopify has no billing or shipping address for this order, and MetaKocka needs a customer on every sales order. Enter one here to send it."}
              </s-paragraph>

              <Form method="post">
                <input type="hidden" name="intent" value="save-partner" />

                <s-stack direction="block" gap="base">
                  <s-box maxInlineSize="520px">
                    <s-text-field
                      name="customer"
                      label="Customer or company name"
                      defaultValue={partnerOverride?.customer ?? ""}
                      required
                      details="The only detail MetaKocka will not do without."
                    />
                  </s-box>

                  <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                    <s-text-field
                      name="street"
                      label="Street and number"
                      defaultValue={partnerOverride?.street ?? ""}
                      details="MetaKocka needs an address to identify a new partner by."
                    />
                    <s-text-field
                      name="postNumber"
                      label="Post code"
                      defaultValue={partnerOverride?.postNumber ?? ""}
                    />
                  </s-grid>

                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-text-field
                      name="place"
                      label="Town or city"
                      defaultValue={partnerOverride?.place ?? ""}
                    />
                    <s-text-field
                      name="country"
                      label="Country"
                      defaultValue={partnerOverride?.country ?? ""}
                      details="As MetaKocka spells it. Northern Ireland is its own country there."
                    />
                  </s-grid>

                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-email-field
                      name="email"
                      label="Email"
                      defaultValue={partnerOverride?.email ?? ""}
                    />
                    <s-text-field
                      name="phone"
                      label="Phone"
                      defaultValue={partnerOverride?.phone ?? ""}
                    />
                  </s-grid>

                  <s-checkbox
                    name="isBusiness"
                    label="This is a business"
                    details="Sets the partner as a taxable business entity in MetaKocka."
                    {...(partnerOverride?.isBusiness ? { checked: true } : {})}
                  />

                  <s-box maxInlineSize="320px">
                    <s-text-field
                      name="taxNumber"
                      label="Tax number"
                      defaultValue={partnerOverride?.taxNumber ?? ""}
                      details="Optional. Used to match an existing partner in MetaKocka."
                    />
                  </s-box>

                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-button
                      type="submit"
                      variant="primary"
                      {...(busy ? { disabled: true } : {})}
                    >
                      Save and send to MetaKocka
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>

              {partnerOverride ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="clear-partner" />
                  <s-button
                    type="submit"
                    variant="tertiary"
                    {...(busy ? { disabled: true } : {})}
                  >
                    Remove these details
                  </s-button>
                </Form>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        <s-section heading="MetaKocka documents">
          {order.documents.length === 0 ? (
            <s-paragraph>
              Nothing has been written to MetaKocka for this order yet.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              {order.documents.map((document) => (
                <s-grid
                  key={document.id}
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-text type="strong">{document.countCode}</s-text>
                      {document.isPrimary ? (
                        <s-badge tone="info">Primary</s-badge>
                      ) : null}
                    </s-stack>
                    <s-text color="subdued">
                      {`${document.sourceName ?? "Unknown source"}${
                        document.paymentMarkedAt
                          ? ` — paid ${
                              document.paymentAmountMinor === null
                                ? ""
                                : `${formatMoney(document.paymentAmountMinor, order.currency)} `
                            }${
                              document.paymentType
                                ? `as ${document.paymentType} `
                                : ""
                            }on ${formatDateTime(document.paymentMarkedAt)}`
                          : document.status === "written"
                            ? " — not marked paid"
                            : ""
                      }`}
                    </s-text>

                    {/*
                      * The way out to the ERP.
                      *
                      * `target="_blank"` because this app is an iframe inside
                      * admin.shopify.com: without it MetaKocka would try to
                      * load inside the frame, which it will not do, and the
                      * link would simply appear broken.
                      */}
                    {document.metakockaUrl ? (
                      <s-link href={document.metakockaUrl} target="_blank">
                        Open in MetaKocka
                      </s-link>
                    ) : null}
                  </s-stack>
                  {/*
                    * Two facts, not one: what this app did, and what MetaKocka
                    * has done since. A document that was written last Tuesday
                    * and delivered on Thursday used to read as "written"
                    * forever, because nothing ever asked (§3: MetaKocka pushes
                    * nothing but stock).
                    */}
                  <s-stack direction="block" gap="small-500">
                    <s-badge
                      tone={
                        document.status === "written"
                          ? "success"
                          : document.status === "failed"
                            ? "critical"
                            : "neutral"
                      }
                    >
                      {document.status === "written"
                        ? "Sent"
                        : document.status === "failed"
                          ? "Refused"
                          : "Sending"}
                    </s-badge>
                    {document.mkStatus ? (
                      <s-text color="subdued">
                        {`In MetaKocka: ${document.mkStatus}`}
                      </s-text>
                    ) : null}
                  </s-stack>
                </s-grid>
              ))}
              <s-text color="subdued">
                The primary document carries the shipping and any order-level
                discount. Together the documents come to the Shopify total.
              </s-text>
              {order.documents.some((document) => document.mkCheckedAt) ? (
                <s-text color="subdued">
                  {`MetaKocka last checked ${formatDateTime(
                    order.documents
                      .map((document) => document.mkCheckedAt)
                      .filter((at): at is string => at !== null)
                      .sort()
                      .at(-1)!,
                  )}.`}
                </s-text>
              ) : null}
            </s-stack>
          )}
        </s-section>

        <s-section heading="Actions">
          <s-stack direction="inline" gap="base" alignItems="center">
            <Form method="post">
              <input type="hidden" name="intent" value="reallocate" />
              <s-button
                type="submit"
                variant="secondary"
                {...(busy ? { disabled: true } : {})}
              >
                Allocate again
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="retry-metakocka" />
              <s-button
                type="submit"
                variant="secondary"
                {...(busy ? { disabled: true } : {})}
              >
                Send to MetaKocka again
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="check-shopify" />
              <s-button
                type="submit"
                variant="secondary"
                {...(busy ? { disabled: true } : {})}
              >
                Check with Shopify
              </s-button>
            </Form>
            {order.financialStatus === "paid" && !allDocumentsPaid ? (
              <Form method="post">
                <input type="hidden" name="intent" value="record-payment" />
                <s-button
                  type="submit"
                  variant="secondary"
                  {...(busy ? { disabled: true } : {})}
                >
                  Record the payment in MetaKocka
                </s-button>
              </Form>
            ) : null}
            {order.divergedAt ? (
              <Form method="post">
                <input type="hidden" name="intent" value="accept-shopify" />
                {/*
                  * Named for what it does, not for what a merchant wishes it
                  * did. It records a decision; it does not send anything.
                  */}
                <s-button
                  type="submit"
                  variant="secondary"
                  {...(busy ? { disabled: true } : {})}
                >
                  Mark as sorted in MetaKocka
                </s-button>
              </Form>
            ) : null}
          </s-stack>
          <s-text color="subdued">
            Sending again is safe: a document that already exists is recognised
            by its reference and is not created twice. Recording a payment is
            safe for the same reason — a document that already carries one is
            left alone.
          </s-text>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
