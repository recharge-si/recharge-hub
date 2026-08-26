import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useId, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { listOrders } from "~/adapters/db/repositories/order.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { Dropdown } from "~/web/components/dropdown";
import { formatListDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import {
  describePayment,
  describeProgress,
  isProgressFilter,
  PROGRESS_FILTERS,
} from "~/web/lib/orders";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Orders, newest first, with where each one got to.
 *
 * An index, laid out the way the admin's own order index is: one row per order,
 * columns in the order the questions get asked, and the answer readable without
 * opening anything. It used to be a stack of paragraphs, which meant three
 * lines of prose per order and no way to compare two of them at a glance.
 *
 * The column that matters is the last one. Which supply sources fulfil an order
 * and whether MetaKocka has the documents yet is the question this app exists
 * to answer, so it gets the width at the end of the row rather than a clause in
 * the middle of a sentence.
 *
 * `variant="auto"` is what keeps it inside section 2.6 at 375px: Polaris turns
 * the columns into a labelled list rather than letting them scroll sideways.
 *
 * Read from our own database, so no page load waits on MetaKocka (section 2.5).
 */
const HELP_MODAL_ID = "about-orders";

/**
 * Small enough that the merchant reaches the pager rather than the scrollbar,
 * and small enough that one query stays cheap with lines, allocations and
 * documents joined onto every row.
 */
const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim();
  const requested = url.searchParams.get("status") ?? "";
  const status = isProgressFilter(requested) ? requested : "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  /*
   * One row more than fits, which is the whole of the pagination state: if it
   * came back, there is a next page. A separate count query would double the
   * work to answer a question the extra row already answers.
   */
  const rows = await listOrders(principal, {
    limit: PAGE_SIZE + 1,
    skip: (page - 1) * PAGE_SIZE,
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
  });

  const hasNextPage = rows.length > PAGE_SIZE;

  return {
    filters: { q: search, status },
    page,
    hasNextPage,
    hasPreviousPage: page > 1,
    orders: rows.slice(0, PAGE_SIZE).map((order) => {
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
        items: order.lines.reduce((sum, line) => sum + line.quantity, 0),
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

type OrderRowData = Awaited<ReturnType<typeof loader>>["orders"][number];

/**
 * The last column, in one line.
 *
 * Two facts belong here and neither earns a column of its own: which sources
 * are fulfilling the order, and how far MetaKocka has got with the documents
 * they produce. The document count only appears once it says something the
 * status badge does not — that a split order is half written.
 */
function fulfilment(order: OrderRowData): {
  text: string;
  detail: string | null;
} {
  if (order.sources.length === 0) {
    return { text: "Not allocated yet", detail: null };
  }

  const partial =
    order.documents > 1 && order.documentsWritten < order.documents;

  return {
    text: order.sources.join(", "),
    detail: partial
      ? `${order.documentsWritten} of ${order.documents} documents sent`
      : null,
  };
}

export default function Orders() {
  const { orders, filters, page, hasNextPage, hasPreviousPage } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  /*
   * The field is typed into far faster than a round trip, so it holds its own
   * value and hands it to the URL once the merchant pauses. Reading it straight
   * off the loader would drop characters typed while a request was in flight.
   */
  const [query, setQuery] = useState(filters.q);
  useEffect(() => setQuery(filters.q), [filters.q]);

  /*
   * Every control on this page writes to the URL and nothing else, so what the
   * merchant is looking at survives a reload and can be linked to. `replace`
   * keeps a search that was typed one character at a time out of the back
   * button.
   */
  const apply = useCallback(
    (change: Record<string, string>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(change)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          // Any change to what is being looked at starts again at the first
          // page, or page 3 of the old filter becomes an empty page 3.
          if (!("page" in change)) next.delete("page");
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (query === filters.q) return;
    const timer = setTimeout(() => apply({ q: query }), 300);
    return () => clearTimeout(timer);
  }, [query, filters.q, apply]);

  const searching = navigation.state === "loading";
  const filtered = Boolean(filters.q || filters.status);

  /*
   * An empty database and an empty search are different problems, and only one
   * of them is the merchant's to fix. The first explains what will appear here;
   * the second keeps the controls that produced it, so it can be undone.
   */
  if (orders.length === 0 && !filtered) {
    return (
      <s-page heading="Orders" inlineSize="large">
        <s-link slot="breadcrumb-actions" href="/app">
          Home
        </s-link>
        <s-button slot="secondary-actions" href="/app/orders/settings">
          Settings
        </s-button>
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
    <s-page heading="Orders" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      {/*
       * The explanation behind a header action, the same as the products and
       * payment types pages: it is read once, and after that it is in the way.
       */}
      <s-button slot="secondary-actions" href="/app/orders/settings">
        Settings
      </s-button>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About orders">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every order Shopify sends is allocated to one or more supply
            sources, and each source it uses becomes its own sales order in
            MetaKocka.
          </s-paragraph>
          <s-paragraph>
            The last column names the sources an order is fulfilled from. An
            order split across two sources produces two documents, and only one
            of them carries the shipping.
          </s-paragraph>
          <s-paragraph>
            An order that needs attention has an open issue. Open it to see
            what went wrong and what to do about it.
          </s-paragraph>
          <s-link href="/app/exceptions">Go to Needs attention</s-link>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={HELP_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-section accessibilityLabel="Orders">
        {/*
         * A pager with both arrows dead is a row of furniture, so it only
         * appears once there is somewhere to go.
         */}
        <s-table
          variant="auto"
          {...(searching ? { loading: true } : {})}
          {...(hasNextPage || hasPreviousPage ? { paginate: true } : {})}
          {...(hasNextPage ? { hasNextPage: true } : {})}
          {...(hasPreviousPage ? { hasPreviousPage: true } : {})}
          onNextPage={() => apply({ page: String(page + 1) })}
          onPreviousPage={() =>
            apply({ page: page - 1 > 1 ? String(page - 1) : "" })
          }
        >
          {/*
           * A slot rather than a prop: `s-table` takes its filters as slotted
           * children, and Polaris draws them as the bar above the columns.
           *
           * Which orders, then which of those — the same reading order as the
           * admin's own index, where the view sits at the head of the bar and
           * the search runs to the end of it.
           */}
          <s-grid
            slot="filters"
            gridTemplateColumns="auto 1fr"
            gap="small-300"
            alignItems="center"
          >
            <s-box minInlineSize="180px">
              <Dropdown
                name="status"
                label="Status"
                hideLabel
                value={filters.status}
                options={PROGRESS_FILTERS}
                onChange={(value) => apply({ status: value })}
              />
            </s-box>

            <s-search-field
              label="Search orders"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by order number, reference or SKU"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </s-grid>

          {/*
           * A slot rather than a prop: `s-table` takes its filters as slotted
           * children, and Polaris draws them as the bar above the columns.
           */}
          <s-table-header-row>
            <s-table-header listSlot="primary">Order</s-table-header>
            <s-table-header listSlot="kicker">Date</s-table-header>
            <s-table-header listSlot="secondary" format="currency">
              Total
            </s-table-header>
            <s-table-header listSlot="inline">Payment</s-table-header>
            <s-table-header listSlot="inline">MetaKocka</s-table-header>
            <s-table-header listSlot="labeled">Items</s-table-header>
            <s-table-header listSlot="labeled">Fulfilled from</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {orders.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </s-table-body>
        </s-table>

        {orders.length === 0 ? (
          <s-box paddingBlock="large-100">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">No orders match this search.</s-text>
              <s-button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  apply({ q: "", status: "" });
                }}
              >
                Clear filters
              </s-button>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>
    </s-page>
  );
}

function OrderRow({ order }: { order: OrderRowData }) {
  /*
   * The whole row is clickable, and what it clicks is the link already in it,
   * so keyboard and screen reader users reach the order through the same
   * target rather than a second one bolted alongside. An id attribute cannot
   * hold the colons React puts in a generated id.
   */
  const linkId = `order-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const progress = describeProgress(order.status);
  const payment = describePayment(order.financialStatus);
  const where = fulfilment(order);

  return (
    <s-table-row clickDelegate={linkId}>
      <s-table-cell>
        <s-link id={linkId} href={`/app/orders/${order.id}`}>
          {`#${order.number}`}
        </s-link>
      </s-table-cell>

      <s-table-cell>
        <s-text color="subdued">{formatListDateTime(order.receivedAt)}</s-text>
      </s-table-cell>

      <s-table-cell>
        {formatMoney(order.totalMinor, order.currency)}
      </s-table-cell>

      <s-table-cell>
        <s-badge tone={payment.tone}>{payment.label}</s-badge>
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-badge tone={progress.tone}>{progress.label}</s-badge>
          {/*
           * Only when it is not already the reason the badge is red, so one
           * problem is never counted twice in the same row.
           */}
          {order.openExceptions > 0 && order.status !== "needs_attention" ? (
            <s-badge tone="critical">
              {order.openExceptions === 1
                ? "1 issue"
                : `${order.openExceptions} issues`}
            </s-badge>
          ) : null}
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        {order.items === 1 ? "1 item" : `${order.items} items`}
      </s-table-cell>

      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          <s-text {...(order.sources.length === 0 ? { color: "subdued" } : {})}>
            {where.text}
          </s-text>
          {where.detail ? (
            <s-text color="subdued">{where.detail}</s-text>
          ) : null}
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
