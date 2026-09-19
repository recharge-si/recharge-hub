import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getCatalogueState } from "~/adapters/db/repositories/catalogue.server";
import { getDashboard } from "~/adapters/db/repositories/dashboard.server";
import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { listExceptions } from "~/adapters/db/repositories/exception.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import {
  countVariantStatesFor,
  listCampaigns,
} from "~/adapters/db/repositories/sale-campaign.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { componentOf } from "~/domain/readiness";
import { DistributionBars } from "~/web/components/distribution-bars";
import { HomeStatus, type StatusRow } from "~/web/components/home-status";
import { OrderChart } from "~/web/components/order-chart";
import { ReadinessList } from "~/web/components/readiness-list";
import { RecentActivity } from "~/web/components/recent-activity";
import { SetupBanner } from "~/web/components/setup-banner";
import { describeEvent } from "~/web/lib/activity";
import { exceptionAction } from "~/web/lib/exceptions";
import { ago, modulesOn, salesOverview } from "~/web/lib/home";
import { principalFromSession } from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { describeDiscount, formatInZone } from "~/web/lib/sales";

/**
 * The operations dashboard.
 *
 * docs/BUILD_SPEC.md section 2.7 is explicit that a static welcome card fails
 * Built for Shopify: the home page has to be dynamic and diagnostic, and it has
 * to answer four questions within seconds of being opened.
 *
 *  1. **Does anything need me?** Needs attention, first in the main column
 *     when there is anything in it, with a button per row that goes somewhere
 *     the merchant can actually fix it.
 *  2. **What has happened today?** One row of figures, one per thing this
 *     shop has switched on, and the orders chart under it for a shop that
 *     sends orders.
 *  3. **What is on sale?** The live campaigns and the next one due.
 *  4. **Is everything working, and when did it last run?** The status card
 *     in the sidebar, from the one shared readiness model
 *     (`domain/readiness`) with each part's last run beside it.
 *
 * Only what is switched on is shown (`web/lib/home`): a shop that does not
 * send orders sees no order figures, no order chart and no "orders last
 * checked", because a true number about a thing that is off is still noise.
 * Healthy is calm: no green banners, neutral text for what works, and the one
 * thing that is wrong is the loudest element on the screen.
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

  const now = new Date();
  const [
    dashboard,
    events,
    readiness,
    exceptions,
    campaigns,
    catalogue,
    productSync,
  ] = await Promise.all([
    getDashboard(principal, now),
    recentEvents(principal, 8),
    getReadiness(principal),
    listExceptions(principal, { status: "open", limit: 5 }),
    listCampaigns(principal),
    getCatalogueState(principal),
    getProductSyncSetting(principal),
  ]);
  const campaignCounts = await countVariantStatesFor(
    campaigns.map((campaign) => campaign.id),
  );

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
    sales: salesOverview(
      campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        discount: describeDiscount(
          { type: campaign.discountType, value: campaign.discountValue },
          campaign.currency,
        ),
        startsAt: campaign.startsAt?.toISOString() ?? null,
        endsAt: campaign.endsAt?.toISOString() ?? null,
        counts: campaignCounts.get(campaign.id) ?? {},
      })),
    ),
    timeZone: catalogue.ianaTimezone ?? "UTC",
    productSync: {
      enabled: productSync.enabled,
      scheduled: productSync.scheduleEnabled,
      lastRunAt: productSync.lastRunAt?.toISOString() ?? null,
    },
  };
};

/**
 * One number and what it means. Fixed block size so the row does not reflow as
 * the figures change (section 2.5: CLS at 0.1).
 */
function Metric({
  label,
  value,
  note,
  critical,
}: {
  label: string;
  value: number | string;
  note?: string;
  critical?: boolean;
}) {
  return (
    <s-box
      padding="small-100"
      borderWidth="base"
      borderStyle="solid"
      borderColor="subdued"
      borderRadius="base"
      minBlockSize="88px"
    >
      <s-stack direction="block" gap="small-500">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{String(value)}</s-heading>
        {note ? (
          <s-text color="subdued" tone={critical ? "critical" : "auto"}>
            {note}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

export default function Home() {
  const {
    dashboard,
    readiness,
    attention,
    events,
    sales,
    timeZone,
    productSync,
  } = useLoaderData<typeof loader>();

  const { counts, series, warehouseShares, splitOrders, unsplit, windowDays } =
    dashboard;
  const openExceptions = dashboard.openExceptionsByKind.reduce(
    (sum, entry) => sum + entry.count,
    0,
  );
  const on = modulesOn(readiness.components);
  const component = (key: (typeof readiness.components)[number]["key"]) =>
    readiness.components.find((entry) => entry.key === key) ?? null;
  const problems = readiness.components.filter(
    (entry) => entry.status === "needs_attention",
  );
  const n = (value: number) => value.toLocaleString("en");

  /* The status card: each part of the integration, with its last run. */
  const rows: StatusRow[] = [];
  const push = (
    key: Parameters<typeof component>[0],
    lastRun: StatusRow["lastRun"] = null,
  ) => {
    const entry = component(key);
    if (!entry) return;
    rows.push({
      key,
      title: entry.title,
      status: entry.status,
      summary: entry.summary,
      lastRun: entry.status === "disabled" ? null : lastRun,
      action: entry.action,
    });
  };
  push("metakocka", {
    text: `Last write ${ago(dashboard.lastMetakockaWriteAt)}`,
  });
  push("orders", { text: `Checked ${ago(dashboard.lastOrderSyncAt)}` });
  if (on.has("orders")) push("payments");
  push("stock", {
    text:
      dashboard.lastStockSyncOk === false
        ? `Last run failed, ${ago(dashboard.lastStockSyncAt)}`
        : `Synced ${ago(dashboard.lastStockSyncAt)}`,
    failed: dashboard.lastStockSyncOk === false,
  });
  if (on.has("orders")) push("taxes");
  const products = component("products");
  if (products) {
    rows.push({
      key: "products",
      title: "Product names",
      status: productSync.enabled ? products.status : "disabled",
      summary: productSync.enabled ? products.summary : "Not written",
      lastRun: productSync.enabled
        ? {
            text: `${productSync.scheduled ? "Synced" : "Last synced by hand"} ${ago(productSync.lastRunAt)}`,
          }
        : null,
      action: products.action,
    });
  }
  rows.push({
    key: "sales",
    title: "Sales",
    status:
      sales.failed > 0 || sales.needsDecision > 0 ? "needs_attention" : "info",
    summary:
      sales.active.length > 0
        ? `${n(sales.active.length)} ${sales.active.length === 1 ? "campaign" : "campaigns"} live, ${n(sales.onSale)} variants on sale`
        : sales.next
          ? `Next starts ${formatInZone(sales.next.startsAt, timeZone)}`
          : "No campaign running",
    lastRun:
      sales.failed > 0
        ? { text: `${n(sales.failed)} variants failed` }
        : sales.needsDecision > 0
          ? { text: `${n(sales.needsDecision)} variants need a decision` }
          : null,
    action: { label: "Open sales", href: "/app/sales" },
  });

  /* Today's figures: one per thing that is on. */
  const metrics: Array<{
    label: string;
    value: number;
    note?: string;
    critical?: boolean;
  }> = [];
  if (on.has("orders")) {
    metrics.push({ label: "Orders received", value: counts.receivedToday });
    metrics.push({
      label: "Sent to MetaKocka",
      value: counts.writtenToday,
      ...(counts.allocatedToday > counts.writtenToday
        ? { note: `${counts.allocatedToday - counts.writtenToday} on the way` }
        : {}),
    });
  }
  if (on.has("payments")) {
    metrics.push({
      label: "Payments recorded",
      value: counts.paymentsToday,
      ...(dashboard.ordersAwaitingPayment > 0
        ? {
            note: `${dashboard.ordersAwaitingPayment} paid, not yet recorded`,
            critical: true,
          }
        : {}),
    });
  }
  if (on.has("stock")) {
    metrics.push({
      label: "Products restocked",
      value: counts.stockUpdatesToday,
    });
  }
  metrics.push({
    label: "Variants on sale",
    value: sales.onSale,
    ...(sales.active.length > 0
      ? {
          note: `${n(sales.active.length)} ${sales.active.length === 1 ? "campaign" : "campaigns"}`,
        }
      : {}),
  });

  return (
    <s-page heading="Recharge Hub" inlineSize="base">
      <s-stack direction="block" gap="base">
        {/*
         * Two things can be wrong at once and they are not the same thing:
         * setup was never finished, or it was and something has since stopped
         * being true. Never both banners at once -- section 2.8 forbids two
         * banners close together.
         */}
        {!readiness.activated ? (
          <SetupBanner
            components={readiness.components}
            overall={readiness.overall}
          />
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

        {/* --- Needs attention: first, because it is the one thing that needs a person. --- */}

        {attention.length > 0 ? (
          <s-section
            heading={`Needs attention${openExceptions > attention.length ? ` (${openExceptions})` : ""}`}
          >
            <s-stack direction="block" gap="small-100">
              {attention.map((entry, index) => {
                const action = exceptionAction(entry.kind);
                const href =
                  action?.href ??
                  (entry.orderId ? `/app/orders/${entry.orderId}` : null);
                const label = action?.label ?? "Review order";

                return (
                  <s-stack key={entry.id} direction="block" gap="small-300">
                    {index > 0 ? <s-divider /> : null}
                    <s-grid
                      gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
                      gap="small-300"
                      alignItems="center"
                      paddingBlock="small-400"
                    >
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">
                          {entry.orderNumber
                            ? `Order ${entry.orderNumber}`
                            : "This store"}
                        </s-text>
                        <s-text color="subdued">{entry.message}</s-text>
                      </s-stack>
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
                    </s-grid>
                  </s-stack>
                );
              })}
              <s-divider />
              <s-box paddingBlockStart="small-300">
                <s-link href="/app/exceptions">
                  {openExceptions > attention.length
                    ? `See all ${openExceptions}`
                    : "Go to Needs attention"}
                </s-link>
              </s-box>
            </s-stack>
          </s-section>
        ) : null}

        {/* --- Today ------------------------------------------------------- */}

        <s-section heading="Today">
          {/*
           * Two columns on a phone rather than four squeezed ones. Section
           * 2.6 requires 375px with no horizontal scroll, and a container
           * query keeps that in the layout rather than in a media query
           * about the whole viewport -- this card is not the whole viewport.
           */}
          <s-grid
            gridTemplateColumns={`@container (inline-size <= 560px) 1fr 1fr, ${metrics.map(() => "1fr").join(" ")}`}
            gap="small-300"
          >
            {metrics.map((metric) => (
              <Metric key={metric.label} {...metric} />
            ))}
          </s-grid>
        </s-section>

        {/* --- Sales ------------------------------------------------------- */}

        <s-section heading="Sales">
          <s-stack direction="block" gap="base">
            {sales.active.length === 0 && !sales.next ? (
              <s-text color="subdued">
                {sales.total === 0
                  ? "No sale campaigns yet. A campaign changes the prices of the products its rules match, and puts them back when it ends."
                  : "No campaign is running or scheduled."}
              </s-text>
            ) : (
              <s-stack direction="block" gap="small-300">
                {sales.active.slice(0, 3).map((campaign, index) => (
                  <s-stack key={campaign.id} direction="block" gap="small-300">
                    {index > 0 ? <s-divider /> : null}
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="small-500">
                        <s-link href={`/app/sales/${campaign.id}`}>
                          {campaign.name}
                        </s-link>
                        <s-text color="subdued">
                          {`${campaign.discount} · ${n(campaign.onSale)} variants on sale · ${campaign.endsAt ? `ends ${formatInZone(campaign.endsAt, timeZone)}` : "no end date"}`}
                        </s-text>
                      </s-stack>
                      <s-badge tone="success">Live</s-badge>
                    </s-grid>
                  </s-stack>
                ))}
                {sales.next ? (
                  <s-stack direction="block" gap="small-300">
                    {sales.active.length > 0 ? <s-divider /> : null}
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-stack direction="block" gap="small-500">
                        <s-link href={`/app/sales/${sales.next.id}`}>
                          {sales.next.name}
                        </s-link>
                        <s-text color="subdued">
                          {`${sales.next.discount} · starts ${formatInZone(sales.next.startsAt, timeZone)}`}
                        </s-text>
                      </s-stack>
                      <s-badge tone="neutral">Scheduled</s-badge>
                    </s-grid>
                  </s-stack>
                ) : null}
              </s-stack>
            )}
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-button variant="secondary" href="/app/sales/new">
                New sale
              </s-button>
              <s-link href="/app/sales">
                {sales.total > 0
                  ? `All campaigns (${n(sales.total)})`
                  : "All campaigns"}
              </s-link>
            </s-stack>
          </s-stack>
        </s-section>

        {/* --- Orders: only for a shop that sends them. -------------------- */}

        {on.has("orders") ? (
          <s-section heading={`Orders over the last ${windowDays} days`}>
            <s-stack direction="block" gap="base">
              <OrderChart points={series} />
              {/*
               * A breakdown by warehouse, for a shop that has warehouses on
               * its documents. One that writes a single sales order per
               * Shopify order does not, and a chart of one bar labelled
               * "Unknown warehouse" would be stating something untrue about
               * their setup rather than saying nothing.
               */}
              {!unsplit && warehouseShares.length > 0 ? (
                <s-stack direction="block" gap="small-300">
                  <s-divider />
                  <s-text type="strong">Where orders were filed</s-text>
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
              ) : null}
              <s-link href="/app/orders">All orders</s-link>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>

      <s-stack slot="aside" direction="block" gap="base">
        <HomeStatus rows={rows} />
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
