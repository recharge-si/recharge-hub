import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getDashboard } from "~/adapters/db/repositories/dashboard.server";
import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { listExceptions } from "~/adapters/db/repositories/exception.server";
import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { componentOf } from "~/domain/readiness";
import { DistributionBars } from "~/web/components/distribution-bars";
import { OrderChart } from "~/web/components/order-chart";
import { ReadinessList } from "~/web/components/readiness-list";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeEvent } from "~/web/lib/activity";
import { exceptionAction } from "~/web/lib/exceptions";
import { principalFromSession } from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";

/**
 * The operations dashboard.
 *
 * docs/BUILD_SPEC.md section 2.7 is explicit that a static welcome card fails
 * Built for Shopify: the home page has to be dynamic and diagnostic, and it has
 * to answer four questions within seconds of being opened.
 *
 *  1. **Is everything working?** The health block at the top, from the one
 *     shared readiness model (`domain/readiness`) rather than from this page's
 *     own idea of "configured".
 *  2. **What has happened today?** The metric row, and the two charts under it.
 *  3. **Does anything need me?** Needs attention, with a button per row that
 *     goes somewhere the merchant can actually fix it.
 *  4. **When did the systems last talk?** The two timestamps in the health
 *     block.
 *
 * Healthy is calm. There are no green banners on this page: colour marks
 * exceptions (docs/ui-conventions.md), so a shop with nothing wrong sees
 * numbers and neutral badges, and the one thing that is wrong is the loudest
 * element on the screen.
 *
 * Everything is read from our own database and server rendered. Section 2.5
 * forbids a page load awaiting MetaKocka, and this is the page most likely to
 * be opened first.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const existing = await findShop(principal);
  const shop = existing ?? (await ensureShop(principal));

  /*
   * A brand-new install goes straight to guided setup.
   *
   * Only when nothing has ever been configured: a merchant who has started
   * setting up, or who was running before guided setup existed, gets the
   * dashboard with a banner instead. An install that has been dropped halfway
   * is not the same as a fresh one, and being sent back to step one every
   * morning would be its own problem.
   */
  if (shop.setupCompletedAt === null && shop.setupStep === null) {
    const readiness = await getReadiness(principal);
    if (componentOf(readiness, "metakocka").status === "needs_attention") {
      /*
       * With the query string, because this is the one redirect that runs
       * on the first document request. Dropping it takes `host` with it,
       * App Bridge never initialises, and guided setup renders into a
       * blank frame. See `redirectWithin`.
       */
      throw redirectWithin(request, "/app/setup");
    }
  }

  const [dashboard, events, readiness, exceptions] = await Promise.all([
    getDashboard(principal, new Date()),
    recentEvents(principal, 8),
    getReadiness(principal),
    listExceptions(principal, { status: "open", limit: 5 }),
  ]);

  return {
    dashboard,
    readiness: {
      components: readiness.components,
      overall: readiness.overall,
      activated: readiness.activated,
    },
    attention: exceptions.map((exception) => ({
      id: exception.id,
      kind: exception.kind,
      message: exception.message,
      orderId: exception.order?.id ?? null,
      orderNumber: exception.order?.shopifyOrderNumber ?? null,
    })),
    events: events.map((event) => {
      const described = describeEvent(
        { event: event.event, detail: event.detail },
        undefined,
        event.entityId,
      );
      return {
        id: event.id,
        at: event.at.toISOString(),
        title: described.title,
        text: described.text,
        ok: described.ok,
      };
    }),
  };
};

/** How long ago, in the words a person would use. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * One number and what it means. Fixed block size so the row does not reflow as
 * the figures change (section 2.5: CLS at 0.1).
 */
function Metric({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number | string;
  tone?: "critical";
  note?: string;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderStyle="solid"
      borderColor="subdued"
      borderRadius="base"
      minBlockSize="104px"
    >
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{String(value)}</s-heading>
        {note ? (
          <s-text
            color="subdued"
            tone={tone === "critical" ? "caution" : "auto"}
          >
            {note}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/** One line of the health block: what it is, and one word for how it is. */
function HealthRow({
  title,
  summary,
  critical,
}: {
  title: string;
  summary: string;
  critical: boolean;
}) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
      <s-text>{title}</s-text>
      {critical ? (
        <s-badge tone="critical">Needs attention</s-badge>
      ) : (
        <s-text color="subdued">{summary}</s-text>
      )}
    </s-grid>
  );
}

export default function Home() {
  const { dashboard, readiness, attention, events } =
    useLoaderData<typeof loader>();

  const { counts, series, warehouseShares, splitOrders, unsplit, windowDays } =
    dashboard;
  const openExceptions = dashboard.openExceptionsByKind.reduce(
    (sum, entry) => sum + entry.count,
    0,
  );

  const health = readiness.components.filter((component) =>
    ["metakocka", "orders", "stock", "payments"].includes(component.key),
  );
  const problems = readiness.components.filter(
    (component) => component.status === "needs_attention",
  );

  return (
    <s-page heading="Fulfilment orchestrator">
      <s-stack direction="block" gap="large">
        {/*
         * Two things can be wrong at once and they are not the same thing:
         * setup was never finished, or it was and something has since stopped
         * being true. Never both banners at once -- section 2.8 forbids two
         * banners close together.
         */}
        {!readiness.activated ? (
          <s-banner tone="warning" heading="Synchronization has not started">
            <s-paragraph>
              Nothing is sent to MetaKocka until you finish setup. Whatever you
              have already answered is saved.
            </s-paragraph>
            <s-link slot="primary-action" href="/app/setup">
              Finish setup
            </s-link>
          </s-banner>
        ) : problems.length > 0 ? (
          <s-banner
            tone="warning"
            heading={`Setup needs attention: ${problems.length} ${problems.length === 1 ? "setting" : "settings"}`}
          >
            <s-stack direction="block" gap="base">
              <ReadinessList components={problems} onlyProblems />
            </s-stack>
          </s-banner>
        ) : null}

        {/* --- Health ------------------------------------------------------ */}

        <s-section heading="Integration">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-300">
              {health.map((component) => (
                <HealthRow
                  key={component.key}
                  title={component.title}
                  summary={component.summary}
                  critical={component.status === "needs_attention"}
                />
              ))}
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="small-400">
              <s-grid gridTemplateColumns="1fr auto" gap="base">
                <s-text color="subdued">Last MetaKocka write</s-text>
                <s-text color="subdued">
                  {ago(dashboard.lastMetakockaWriteAt)}
                </s-text>
              </s-grid>
              <s-grid gridTemplateColumns="1fr auto" gap="base">
                <s-text color="subdued">Last stock sync</s-text>
                <s-text
                  color="subdued"
                  tone={
                    dashboard.lastStockSyncOk === false ? "caution" : "auto"
                  }
                >
                  {ago(dashboard.lastStockSyncAt)}
                </s-text>
              </s-grid>
              <s-grid gridTemplateColumns="1fr auto" gap="base">
                <s-text color="subdued">Orders last checked</s-text>
                <s-text color="subdued">
                  {ago(dashboard.lastOrderSyncAt)}
                </s-text>
              </s-grid>
            </s-stack>
          </s-stack>
        </s-section>

        {/* --- Today ------------------------------------------------------- */}

        <s-section heading="Today">
          <s-stack direction="block" gap="base">
            {/*
             * Two columns on a phone rather than four squeezed ones. Section
             * 2.6 requires 375px with no horizontal scroll, and a container
             * query keeps that in the layout rather than in a media query
             * about the whole viewport -- this card is not the whole viewport.
             */}
            <s-grid
              gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr 1fr"
              gap="base"
            >
              <Metric label="Orders received" value={counts.receivedToday} />
              <Metric
                label="Sent to MetaKocka"
                value={counts.writtenToday}
                note={
                  counts.allocatedToday > counts.writtenToday
                    ? `${counts.allocatedToday - counts.writtenToday} still on the way`
                    : undefined
                }
              />
              <Metric label="Payments recorded" value={counts.paymentsToday} />
              <Metric
                label="Products restocked"
                value={counts.stockUpdatesToday}
              />
            </s-grid>

            {dashboard.ordersAwaitingPayment > 0 ? (
              <s-text color="subdued" tone="caution">
                {`${dashboard.ordersAwaitingPayment} ${dashboard.ordersAwaitingPayment === 1 ? "order is" : "orders are"} paid in Shopify and not yet recorded in MetaKocka.`}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        {/* --- Needs attention --------------------------------------------- */}

        {attention.length > 0 ? (
          <s-section
            heading={`Needs attention${openExceptions > attention.length ? ` (${openExceptions})` : ""}`}
          >
            <s-stack direction="block" gap="base">
              {attention.map((entry) => {
                const action = exceptionAction(entry.kind);
                const href =
                  action?.href ??
                  (entry.orderId ? `/app/orders/${entry.orderId}` : null);
                const label = action?.label ?? "Review order";

                return (
                  <s-stack key={entry.id} direction="block" gap="small-400">
                    <s-text type="strong">
                      {entry.orderNumber
                        ? `Order ${entry.orderNumber}`
                        : "This store"}
                    </s-text>
                    <s-text color="subdued">{entry.message}</s-text>
                    {href ? (
                      <s-stack direction="inline" gap="small-300">
                        <s-button variant="secondary" href={href}>
                          {label}
                        </s-button>
                        {action && entry.orderId ? (
                          <s-button
                            variant="tertiary"
                            href={`/app/orders/${entry.orderId}`}
                          >
                            Open order
                          </s-button>
                        ) : null}
                      </s-stack>
                    ) : null}
                  </s-stack>
                );
              })}

              {openExceptions > attention.length ? (
                <s-link href="/app/exceptions">
                  {`See all ${openExceptions}`}
                </s-link>
              ) : (
                <s-link href="/app/exceptions">Go to Needs attention</s-link>
              )}
            </s-stack>
          </s-section>
        ) : null}

        {/* --- Charts ------------------------------------------------------ */}

        <s-section heading={`Orders over the last ${windowDays} days`}>
          <s-stack direction="block" gap="base">
            <OrderChart points={series} />
            <s-link href="/app/orders">All orders</s-link>
          </s-stack>
        </s-section>

{/*
         * A breakdown by warehouse, for a shop that has warehouses on its
         * documents. One that writes a single sales order per Shopify order
         * does not, and a chart of one bar labelled "Unknown warehouse" would
         * be stating something untrue about their setup rather than saying
         * nothing.
         */}
        {unsplit ? null : (
          <s-section heading="Where orders were filed">
            <s-stack direction="block" gap="base">
              <DistributionBars
                rows={warehouseShares}
                unit="sales order"
                empty={`No sales orders in the last ${windowDays} days.`}
              />
              {splitOrders > 0 ? (
                <s-text color="subdued">
                  {`${splitOrders} ${splitOrders === 1 ? "order was" : "orders were"} fulfilled from more than one warehouse, so ${splitOrders === 1 ? "it became" : "they became"} a sales order per warehouse.`}
                </s-text>
              ) : null}
            </s-stack>
          </s-section>
        )}

        <s-section heading="Recent activity">
          <RecentActivity
            items={events}
            empty="Nothing has happened yet. Activity shows up here as the app works."
          />
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
