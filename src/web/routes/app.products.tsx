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

import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { countByStatus, listSkus } from "~/adapters/db/repositories/sku.server";
import { listSupplySources } from "~/adapters/db/repositories/supply-source.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Products and stock.
 *
 * Both buttons queue a background job and return immediately (CLAUDE.md §2.5):
 * a full catalogue read and a stock push are slow, and no request waits on
 * MetaKocka. What the page shows is read from our own database.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [counts, unmatched, sources, events] = await Promise.all([
    countByStatus(principal),
    listSkus(principal, "unmatched", 25),
    listSupplySources(principal),
    recentEvents(principal, 30),
  ]);

  const syncEvents = events.filter((event) =>
    ["catalogue.synced", "inventory.synced", "inventory.sync_skipped"].includes(
      event.event,
    ),
  );

  return {
    counts,
    unmatched: unmatched.map((row) => ({
      id: row.id,
      sku: row.sku,
      title: row.title,
    })),
    writableSources: sources.filter(
      (source) =>
        source.enabled &&
        source.inventoryWriter === "metakocka" &&
        source.metakockaWarehouse !== null &&
        source.shopifyLocationId !== null,
    ).length,
    totalSources: sources.length,
    recent: syncEvents.slice(0, 8).map((event) => ({
      id: event.id,
      event: event.event,
      at: event.at.toISOString(),
      detail: event.detail as Record<string, unknown> | null,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync-catalogue") {
    await enqueue(
      QUEUES.syncCatalogue,
      { shopDomain: principal.shopDomain },
      { singletonKey: `catalogue:${principal.shopDomain}` },
    );
    return {
      ok: true,
      message:
        "Reading the catalogue in the background. Refresh in a moment to see the result.",
    };
  }

  if (intent === "sync-inventory") {
    await enqueue(
      QUEUES.syncInventory,
      { shopDomain: principal.shopDomain },
      { singletonKey: `inventory:${principal.shopDomain}` },
    );
    return {
      ok: true,
      message:
        "Pushing stock to Shopify in the background. Refresh in a moment to see the result.",
    };
  }

  return { ok: false, message: "Unknown action." };
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function describe(event: { event: string; detail: Record<string, unknown> | null }) {
  const d = event.detail ?? {};

  if (event.event === "catalogue.synced") {
    return `Catalogue read: ${String(d.variants ?? 0)} variants, ${String(d.matched ?? 0)} matched to MetaKocka, ${String(d.unmatched ?? 0)} not matched.`;
  }
  if (event.event === "inventory.synced") {
    return `Stock pushed for ${String(d.source ?? "")}: ${String(d.written ?? 0)} updated, ${String(d.unchanged ?? 0)} already correct.`;
  }
  return `Stock sync skipped for a source: ${String(d.reason ?? "unknown reason")}.`;
}

export default function Products() {
  const { counts, unmatched, writableSources, totalSources, recent } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const total = counts.matched + counts.unmatched + counts.ignored;

  return (
    <s-page heading="Products and stock">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result?.message ? (
          <s-banner tone={result.ok ? "success" : "critical"}>
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Catalogue">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Every Shopify variant with a SKU is matched to a MetaKocka article
              with the same code. Only matched products have their stock synced.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={counts.matched > 0 ? "success" : "caution"}>
                {counts.matched} matched
              </s-badge>
              <s-badge tone={counts.unmatched > 0 ? "caution" : "neutral"}>
                {counts.unmatched} not matched
              </s-badge>
              <s-text>{total} SKUs in total</s-text>
            </s-stack>
            <Form method="post">
              <input type="hidden" name="intent" value="sync-catalogue" />
              <s-button type="submit" {...(busy ? { disabled: true } : {})}>
                Read catalogue and match
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        <s-section heading="Stock sync">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              MetaKocka stock on hand is written to Shopify on hand, for
              warehouses this app owns. Shopify works out what is available
              itself, so available is never written.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={writableSources > 0 ? "success" : "caution"}>
                {writableSources} of {totalSources} ready
              </s-badge>
              <s-text>
                A warehouse is synced only when it has a Shopify location and
                this app is set as its stock owner.
              </s-text>
            </s-stack>
            <Form method="post">
              <input type="hidden" name="intent" value="sync-inventory" />
              <s-button
                type="submit"
                {...(busy || writableSources === 0 ? { disabled: true } : {})}
              >
                Push stock to Shopify now
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        {counts.unmatched > 0 ? (
          <s-section heading="SKUs without a MetaKocka article">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These Shopify SKUs have no MetaKocka article with the same code,
                so their stock is not synced and orders for them cannot be sent
                to the ERP. Either add the article in MetaKocka with a matching
                code, or correct the SKU in Shopify.
              </s-paragraph>
              <s-unordered-list>
                {unmatched.map((row) => (
                  <s-list-item key={row.id}>
                    {row.sku}
                    {row.title ? ` — ${row.title}` : ""}
                  </s-list-item>
                ))}
              </s-unordered-list>
              {counts.unmatched > unmatched.length ? (
                <s-text>
                  Showing {unmatched.length} of {counts.unmatched}.
                </s-text>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        <s-section heading="Recent syncs">
          {recent.length === 0 ? (
            <s-paragraph>Nothing synced yet.</s-paragraph>
          ) : (
            <s-unordered-list>
              {recent.map((event) => (
                <s-list-item key={event.id}>
                  {formatDateTime(event.at)} — {describe(event)}
                </s-list-item>
              ))}
            </s-unordered-list>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
