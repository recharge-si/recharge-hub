import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getDashboard } from "~/adapters/db/repositories/dashboard.server";
import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { getCredentialSummary } from "~/adapters/db/repositories/metakocka-credential.server";
import { listPaymentTypeMaps } from "~/adapters/db/repositories/payment-type-map.server";
import { listSupplySources } from "~/adapters/db/repositories/supply-source.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { OrderChart } from "~/web/components/order-chart";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeEvent } from "~/web/lib/activity";
import { formatDateTime } from "~/web/lib/datetime";
import { describeExceptionKind } from "~/web/lib/exceptions";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The operations dashboard.
 *
 * §2.7 is explicit that a static welcome card fails Built for Shopify: the home
 * page must be dynamic and diagnostic, and must show setup state, whether
 * syncing is working, and real metrics. So the top of this page is what is
 * happening right now, and setup drops to the bottom once it is done — a
 * merchant who has finished connecting should not be looking at a checklist
 * every morning.
 *
 * Everything is read from our own database and server rendered. §2.5 forbids a
 * page load awaiting MetaKocka, and this is the page most likely to be opened
 * first.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [existing, dashboard, events, metakocka, sources, paymentMaps] =
    await Promise.all([
      findShop(principal),
      getDashboard(principal, new Date()),
      recentEvents(principal, 8),
      getCredentialSummary(principal),
      listSupplySources(principal),
      listPaymentTypeMaps(principal),
    ]);

  const shop = existing ?? (await ensureShop(principal));

  return {
    shopDomain: session.shop,
    installedAt: shop.installedAt.toISOString(),
    dashboard,
    metakocka: {
      connected: metakocka.connected,
      verified: metakocka.lastVerifiedAt !== null,
    },
    supplySources: {
      total: sources.length,
      ready: sources.filter(
        (source) =>
          source.enabled &&
          source.metakockaWarehouse !== null &&
          source.shopifyLocationId !== null,
      ).length,
      syncing: sources.filter((source) => source.stockDirection !== "none")
        .length,
    },
    paymentMappings: paymentMaps.length,
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
 * the figures change (§2.5: CLS at 0.1).
 */
function Metric({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number | string;
  tone?: "critical" | "success";
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

export default function Home() {
  const {
    shopDomain,
    installedAt,
    dashboard,
    events,
    metakocka,
    supplySources,
    paymentMappings,
  } = useLoaderData<typeof loader>();

  const { counts, series, openExceptionsByKind } = dashboard;
  const openExceptions = openExceptionsByKind.reduce(
    (sum, entry) => sum + entry.count,
    0,
  );

  const erp = metakocka.verified
    ? { tone: "success" as const, label: "Connected", note: null }
    : metakocka.connected
      ? {
          tone: "caution" as const,
          label: "Not verified",
          note: "Credentials are saved but have not been used successfully yet. Test the connection on the Connection page.",
        }
      : {
          tone: "caution" as const,
          label: "Not configured",
          note: "Connecting MetaKocka is the next step. Until it is connected, no orders are sent to the ERP and no stock is published.",
        };

  const setupIncomplete =
    !metakocka.verified || supplySources.ready === 0 || paymentMappings === 0;

  return (
    <s-page heading="Fulfilment orchestrator">
      <s-stack direction="block" gap="large">
        {/*
         * Anything needing a person comes first and stays until it is dealt
         * with. §2.8: errors are persistent, never a toast that fades.
         */}
        {openExceptions > 0 ? (
          <s-banner
            tone="critical"
            heading={`${openExceptions} ${openExceptions === 1 ? "order needs" : "orders need"} attention`}
          >
            <s-paragraph>
              {openExceptionsByKind
                .map(
                  (entry) =>
                    `${entry.count} ${describeExceptionKind(entry.kind).short}`,
                )
                .join(", ")}
              .
            </s-paragraph>
            <s-link slot="primary-action" href="/app/exceptions">
              Go to Needs attention
            </s-link>
          </s-banner>
        ) : null}

        <s-section heading="Today">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
              <Metric label="Orders received" value={counts.receivedToday} />
              <Metric label="Allocated" value={counts.allocatedToday} />
              <Metric label="Sent to MetaKocka" value={counts.writtenToday} />
              <Metric
                label="Awaiting attention"
                value={counts.needsAttention}
                tone={counts.needsAttention > 0 ? "critical" : undefined}
                note={
                  counts.needsAttention > 0 ? "Needs a decision" : "All clear"
                }
              />
            </s-grid>

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge
                tone={dashboard.lastMetakockaWriteAt ? "success" : "neutral"}
              >
                {`Last ERP write ${ago(dashboard.lastMetakockaWriteAt)}`}
              </s-badge>
              <s-badge
                tone={
                  dashboard.lastStockSyncOk === null
                    ? "neutral"
                    : dashboard.lastStockSyncOk
                      ? "success"
                      : "caution"
                }
              >
                {`Last stock sync ${ago(dashboard.lastStockSyncAt)}`}
              </s-badge>
              {/*
                * Order sync is the part with no other symptom when it stops: an
                * order paid in Shopify and unpaid in the ERP looks completely
                * normal on both screens (§2.7 asks the home page to say whether
                * syncing is working, not only that it ran).
                */}
              <s-badge
                tone={
                  dashboard.ordersAwaitingPayment > 0
                    ? "caution"
                    : dashboard.lastOrderSyncAt
                      ? "success"
                      : "neutral"
                }
              >
                {dashboard.ordersAwaitingPayment > 0
                  ? `${dashboard.ordersAwaitingPayment} ${dashboard.ordersAwaitingPayment === 1 ? "payment" : "payments"} not yet in MetaKocka`
                  : `Orders checked ${ago(dashboard.lastOrderSyncAt)}`}
              </s-badge>
              <s-badge tone={supplySources.syncing > 0 ? "success" : "neutral"}>
                {`${supplySources.syncing} ${supplySources.syncing === 1 ? "warehouse" : "warehouses"} syncing`}
              </s-badge>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Orders over the last two weeks">
          <s-stack direction="block" gap="base">
            <OrderChart points={series} />
            <s-link href="/app/orders">All orders</s-link>
          </s-stack>
        </s-section>

        {openExceptionsByKind.length > 0 ? (
          <s-section heading="Needs attention by type">
            <s-stack direction="block" gap="small-300">
              {openExceptionsByKind.map((entry) => (
                <s-grid
                  key={entry.kind}
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-text>{describeExceptionKind(entry.kind).label}</s-text>
                  <s-badge tone="critical">{String(entry.count)}</s-badge>
                </s-grid>
              ))}
            </s-stack>
          </s-section>
        ) : null}

        {/*
         * Setup sinks to the bottom once it is done, but never disappears: a
         * merchant who disconnects MetaKocka needs to find this again.
         */}
        <s-section heading={setupIncomplete ? "Finish setting up" : "Setup"}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone="success">Connected</s-badge>
              <s-text>Shopify store {shopDomain}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={erp.tone}>{erp.label}</s-badge>
              <s-link href="/app/settings/metakocka">MetaKocka ERP</s-link>
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={supplySources.ready > 0 ? "success" : "caution"}>
                {supplySources.ready > 0
                  ? `${supplySources.ready} ready`
                  : "None ready"}
              </s-badge>
              <s-link href="/app/settings/supply-sources">Locations</s-link>
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={paymentMappings > 0 ? "success" : "caution"}>
                {paymentMappings > 0
                  ? `${paymentMappings} mapped`
                  : "None mapped"}
              </s-badge>
              <s-link href="/app/settings/payments">Payment types</s-link>
            </s-stack>
            {erp.note ? <s-paragraph>{erp.note}</s-paragraph> : null}
            {supplySources.total > 0 && supplySources.ready === 0 ? (
              <s-paragraph>
                A warehouse is only usable once it has both a MetaKocka
                warehouse and a Shopify location.
              </s-paragraph>
            ) : null}
            <s-text color="subdued">{`Installed ${formatDateTime(installedAt)}.`}</s-text>
          </s-stack>
        </s-section>

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
