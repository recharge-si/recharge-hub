import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getOrderDetail } from "~/adapters/db/repositories/order.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatDateTime } from "~/web/lib/datetime";
import { describeExceptionKind } from "~/web/lib/exceptions";
import { formatMoney } from "~/web/lib/money";
import { describePayment, describeProgress } from "~/web/lib/orders";
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

  return {
    order: {
      id: order.id,
      number: order.shopifyOrderNumber,
      reference: order.customerOrderRef,
      status: order.status,
      financialStatus: order.financialStatus,
      currency: order.presentmentCurrency,
      totalMinor: order.totalMinor,
      shippingMinor: order.shippingMinor,
      discountMinor: order.discountMinor,
      receivedAt: order.receivedAt.toISOString(),
      redacted: order.rawPayload === null,
      lines: order.lines.map((line) => ({
        id: line.id,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
        unitPriceWithTaxMinor: line.unitPriceWithTaxMinor,
        taxFactor: line.taxFactor,
        allocations: line.allocations.map((allocation) => ({
          id: allocation.id,
          quantity: allocation.quantity,
          status: allocation.status,
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
        paymentMarkedAt: document.paymentMarkedAt?.toISOString() ?? null,
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
    await enqueue(
      QUEUES.allocateOrder,
      { shopDomain: session.shop, orderId },
      { singletonKey: `allocate:${orderId}:retry:${Date.now()}` },
    );
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

  return { ok: false, message: "Unknown action." };
};

export default function OrderDetail() {
  const { order } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const openExceptions = order.exceptions.filter(
    (exception) => exception.status === "open",
  );

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

        <s-section heading="Lines and where they are fulfilled from">
          <s-stack direction="block" gap="none">
            {order.lines.map((line, index) => (
              <s-box key={line.id} paddingBlock="base">
                {index === 0 ? null : (
                  <s-box paddingBlockEnd="base">
                    <s-divider />
                  </s-box>
                )}

                <s-stack direction="block" gap="small-300">
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="base"
                    alignItems="center"
                  >
                    <s-text type="strong">{line.title}</s-text>
                    <s-text>
                      {`${line.quantity} x ${formatMoney(line.unitPriceWithTaxMinor, order.currency)}`}
                    </s-text>
                  </s-grid>

                  <s-text color="subdued">
                    {line.sku
                      ? `SKU ${line.sku}${line.taxFactor ? ` — tax factor ${line.taxFactor}` : ""}`
                      : "No SKU on this line, so it cannot be matched to a MetaKocka product."}
                  </s-text>

                  {/*
                   * The decision trail. Each allocation says which source took
                   * how many and why, which is the whole point of the app.
                   */}
                  {line.allocations.length === 0 ? (
                    <s-text color="subdued">Not allocated yet.</s-text>
                  ) : (
                    line.allocations.map((allocation) => (
                      <s-box
                        key={allocation.id}
                        paddingInlineStart="base"
                        paddingBlock="small-400"
                        background="subdued"
                        borderRadius="base"
                      >
                        <s-stack direction="block" gap="small-500">
                          <s-stack
                            direction="inline"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-badge
                              tone={
                                allocation.sourceName ? "success" : "critical"
                              }
                            >
                              {allocation.sourceName ?? "Needs a decision"}
                            </s-badge>
                            <s-text>{`${allocation.quantity} of ${line.quantity}`}</s-text>
                          </s-stack>
                          {allocation.reason ? (
                            <s-text color="subdued">{allocation.reason}</s-text>
                          ) : null}
                        </s-stack>
                      </s-box>
                    ))
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>

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
                        document.mkId ? ` — MetaKocka id ${document.mkId}` : ""
                      }${
                        document.paymentMarkedAt
                          ? ` — marked paid ${formatDateTime(document.paymentMarkedAt)}`
                          : ""
                      }`}
                    </s-text>
                  </s-stack>
                  <s-badge
                    tone={
                      document.status === "written"
                        ? "success"
                        : document.status === "failed"
                          ? "critical"
                          : "neutral"
                    }
                  >
                    {document.status}
                  </s-badge>
                </s-grid>
              ))}
              <s-text color="subdued">
                The primary document carries the shipping and any order-level
                discount. Together the documents come to the Shopify total.
              </s-text>
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
          </s-stack>
          <s-text color="subdued">
            Sending again is safe: a document that already exists is recognised
            by its reference and is not created twice.
          </s-text>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
