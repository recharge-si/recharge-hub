import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { getCredentialSummary } from "~/adapters/db/repositories/metakocka-credential.server";
import { listPaymentTypeMaps } from "~/adapters/db/repositories/payment-type-map.server";
import { listSupplySources } from "~/adapters/db/repositories/supply-source.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The home page. CLAUDE.md section 2.7 requires it to be dynamic and diagnostic
 * rather than a static welcome card, and section 2.5 forbids blocking first paint
 * on MetaKocka. Everything below is read from our own database and server
 * rendered, so no page load ever awaits an ERP call.
 *
 * M1 has no orders and no ERP connection, so the diagnostics it can honestly
 * report are the setup state and the audit trail. M4 adds the live counts that
 * section 2.7 lists: orders received today, automatically allocated, awaiting
 * attention, last successful MetaKocka write, last reconciliation.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const principal = principalFromSession(session);

  const [existing, events, metakocka, sources, paymentMaps] = await Promise.all(
    [
      findShop(principal),
      recentEvents(principal, 5),
      getCredentialSummary(principal),
      listSupplySources(principal),
      listPaymentTypeMaps(principal),
    ],
  );

  // The install hook creates this row. The fallback covers a shop whose row was
  // lost, and keeps the page load a pure read in the normal case.
  const shop = existing ?? (await ensureShop(principal));

  return {
    shopDomain: session.shop,
    installedAt: shop.installedAt.toISOString(),
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
    },
    paymentMappings: paymentMaps.length,
    events: events.map((event) => ({
      id: event.id,
      event: event.event,
      at: event.at.toISOString(),
    })),
  };
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function Home() {
  const {
    shopDomain,
    installedAt,
    events,
    metakocka,
    supplySources,
    paymentMappings,
  } = useLoaderData<typeof loader>();

  const erp = metakocka.verified
    ? { tone: "success" as const, label: "Connected", note: null }
    : metakocka.connected
      ? {
          tone: "caution" as const,
          label: "Not verified",
          note: "Credentials are saved but have not been used successfully yet. Test the connection in settings.",
        }
      : {
          tone: "caution" as const,
          label: "Not configured",
          note: "Connecting MetaKocka is the next step. Until it is connected, no orders are sent to the ERP and no stock is published.",
        };

  return (
    <s-page heading="Fulfilment orchestrator">
      <s-section heading="Setup">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="success">Connected</s-badge>
            <s-text>Shopify store {shopDomain}</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={erp.tone}>{erp.label}</s-badge>
            <s-text>MetaKocka ERP</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={supplySources.ready > 0 ? "success" : "caution"}>
              {supplySources.ready > 0
                ? `${supplySources.ready} ready`
                : "None ready"}
            </s-badge>
            <s-link href="/app/settings/supply-sources">Warehouses</s-link>
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
              A supply source is only usable once it has both a MetaKocka
              warehouse and a Shopify location.
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Installation">
        <s-paragraph>{`Installed ${formatDateTime(installedAt)}.`}</s-paragraph>
      </s-section>

      <s-section heading="Recent activity">
        {events.length === 0 ? (
          <s-paragraph>No activity recorded yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {events.map((event) => (
              <s-list-item key={event.id}>
                {event.event} — {formatDateTime(event.at)}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
