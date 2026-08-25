import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { listOrders } from "~/adapters/db/repositories/order.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";
import { formatMoney } from "~/web/lib/money";

/**
 * Orders, newest first, with where each one got to.
 *
 * The column that matters is the last one: which supply sources fulfil it and
 * whether MetaKocka has the documents yet. That is the question this app exists
 * to answer, and it should be answerable without opening anything.
 *
 * Read from our own database, so no page load waits on MetaKocka (§2.5).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const orders = await listOrders(principal, { limit: 50 });

  return {
    orders: orders.map((order) => {
      const sources = new Set(
        order.lines.flatMap((line) =>
          line.allocations
            .map((allocation) => allocation.supplySource?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      );

      return {
        id: order.id,
        number: order.shopifyOrderNumber,
        receivedAt: order.receivedAt.toISOString(),
        status: order.status,
        financialStatus: order.financialStatus,
        currency: order.presentmentCurrency,
        totalMinor: order.totalMinor,
        lines: order.lines.length,
        sources: [...sources],
        documents: order.documents.length,
        documentsWritten: order.documents.filter(
          (document) => document.status === "written",
        ).length,
        openExceptions: order.exceptions.length,
      };
    }),
  };
};

const STATUS_TONE: Record<string, "success" | "critical" | "neutral" | "info"> =
  {
    received: "neutral",
    allocated: "info",
    written: "success",
    needs_attention: "critical",
    cancelled: "neutral",
  };

const STATUS_LABEL: Record<string, string> = {
  received: "Received",
  allocated: "Allocated",
  written: "Sent to MetaKocka",
  needs_attention: "Needs attention",
  cancelled: "Cancelled",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function Orders() {
  const { orders } = useLoaderData<typeof loader>();

  if (orders.length === 0) {
    return (
      <s-page heading="Orders">
        <s-link slot="breadcrumb-actions" href="/app">
          Home
        </s-link>
        <s-section heading="No orders yet">
          <s-paragraph>
            Orders appear here as Shopify sends them. Each one is allocated to a
            supply source and then written to MetaKocka as a sales order.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Orders">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-section heading={`${orders.length} most recent`}>
        <s-stack direction="block" gap="none">
          {orders.map((order, index) => (
            <s-box key={order.id} paddingBlock="base">
              {index === 0 ? null : (
                <s-box paddingBlockEnd="base">
                  <s-divider />
                </s-box>
              )}

              <s-grid
                gridTemplateColumns="1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-stack direction="block" gap="small-300">
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-text type="strong">{`Order ${order.number}`}</s-text>
                    <s-badge tone={STATUS_TONE[order.status] ?? "neutral"}>
                      {STATUS_LABEL[order.status] ?? order.status}
                    </s-badge>
                    {order.openExceptions > 0 ? (
                      <s-badge tone="critical">
                        {order.openExceptions === 1
                          ? "1 exception"
                          : `${order.openExceptions} exceptions`}
                      </s-badge>
                    ) : null}
                  </s-stack>

                  <s-text color="subdued">
                    {`${formatDateTime(order.receivedAt)} — ${order.lines} ${
                      order.lines === 1 ? "line" : "lines"
                    }, ${formatMoney(order.totalMinor, order.currency)}`}
                  </s-text>

                  <s-text color="subdued">
                    {order.sources.length > 0
                      ? `Fulfilled from ${order.sources.join(", ")}. ${order.documentsWritten} of ${order.documents} ${order.documents === 1 ? "document" : "documents"} in MetaKocka.`
                      : "Not allocated to a supply source yet."}
                  </s-text>
                </s-stack>

                <s-link href={`/app/orders/${order.id}`}>View</s-link>
              </s-grid>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
