import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import type { ShopSession } from "~/domain/types";

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

  const principal: ShopSession = {
    kind: "shop",
    shopDomain: session.shop,
    // Offline sessions carry no user identity. M2 needs the real answer before
    // it can gate the MetaKocka credentials screen to the shop owner
    // (CLAUDE.md section 9); until then, deny.
    isShopOwner: false,
  };

  const [existing, events] = await Promise.all([
    findShop(principal),
    recentEvents(principal, 5),
  ]);

  // The install hook creates this row. The fallback covers a shop whose row was
  // lost, and keeps the page load a pure read in the normal case.
  const shop = existing ?? (await ensureShop(principal));

  return {
    shopDomain: session.shop,
    installedAt: shop.installedAt.toISOString(),
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
  const { shopDomain, installedAt, events } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Fulfilment orchestrator">
      <s-section heading="Setup">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="success">Connected</s-badge>
            <s-text>Shopify store {shopDomain}</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="caution">Not configured</s-badge>
            <s-text>MetaKocka ERP</s-text>
          </s-stack>
          <s-paragraph>
            Connecting MetaKocka is the next step. Until it is connected, no
            orders are sent to the ERP and no stock is published.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Installation">
        <s-paragraph>
          {`Installed ${formatDateTime(installedAt)}.`}
        </s-paragraph>
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
