import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
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
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import { countByStatus, listSkus } from "~/adapters/db/repositories/sku.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeEvent } from "~/web/lib/activity";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Products: which Shopify SKUs have a MetaKocka product behind them.
 *
 * Stock lives on the Locations page, because a quantity only means something
 * once a warehouse has been connected to a location.
 *
 * Reading the catalogue queues a background job and returns immediately
 * (CLAUDE.md section 2.5): MetaKocka has no bulk endpoint, so the read is slow
 * and no request waits on it. What this page shows comes from our database.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [counts, unmatched, events, productSync] = await Promise.all([
    countByStatus(principal),
    listSkus(principal, "unmatched", 25),
    recentEvents(principal, 60),
    getProductSyncSetting(principal),
  ]);

  return {
    counts,
    productSync: {
      enabled: productSync.enabled,
      createMissing: productSync.createMissing,
      namePolicy: productSync.namePolicy,
      nameTemplate: productSync.nameTemplate,
      lastRunAt: productSync.lastRunAt?.toISOString() ?? null,
    },
    unmatched: unmatched.map((row) => ({
      id: row.id,
      sku: row.sku,
      title: row.title,
    })),
    recent: events
      .filter(
        (event) =>
          event.event === "catalogue.synced" ||
          event.event === "products.synced" ||
          event.event === "products.sync_skipped",
      )
      .slice(0, 8)
      .map((event) => {
        const described = describeEvent({
          event: event.event,
          detail: event.detail,
        });
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "sync-catalogue") {
    const jobId = await enqueueThrottled(
      QUEUES.syncCatalogue,
      { shopDomain: principal.shopDomain },
      `catalogue:${principal.shopDomain}`,
      30,
    );

    return jobId
      ? {
          ok: true,
          message:
            "Syncing products in the background. This page updates when it finishes.",
        }
      : {
          ok: true,
          message:
            "A product sync is already running. Waiting for it to finish.",
        };
  }

  if (intent === "sync-products") {
    const jobId = await enqueueThrottled(
      QUEUES.syncProducts,
      { shopDomain: principal.shopDomain },
      `products:${principal.shopDomain}`,
      30,
    );

    return jobId
      ? {
          ok: true,
          message:
            "Sending names to MetaKocka in the background. This page updates when it finishes.",
        }
      : {
          ok: true,
          message:
            "A product sync is already running. Waiting for it to finish.",
        };
  }

  return { ok: false, message: "Unknown action." };
};

export default function Products() {
  const { counts, unmatched, recent, productSync } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const total = counts.matched + counts.unmatched + counts.ignored;

  // Confirmations are toasts, like the rest of the admin. Failures stay on the
  // page as a banner, because section 2.8 requires errors to persist.
  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="Products">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Products and MetaKocka">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Every Shopify variant with a SKU is matched to the MetaKocka
              product that has the same code. Only a matched product can have
              its stock synced or appear on an order sent to the ERP.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={counts.matched > 0 ? "success" : "caution"}>
                {counts.matched} matched
              </s-badge>
              <s-badge tone={counts.unmatched > 0 ? "caution" : "neutral"}>
                {counts.unmatched} not matched
              </s-badge>
              <s-text color="subdued">{`${total} SKUs in total`}</s-text>
            </s-stack>

            <s-divider />

            <s-paragraph>
              Syncing reads both catalogues and matches them by code. If sending
              names is on, it then writes your names into MetaKocka and creates
              a product for any SKU MetaKocka does not have.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={productSync.enabled ? "success" : "neutral"}>
                {productSync.enabled
                  ? "Sending names is on"
                  : "Sending names is off"}
              </s-badge>
              {productSync.enabled ? (
                <s-badge tone={productSync.createMissing ? "info" : "neutral"}>
                  {productSync.createMissing
                    ? "Creates missing products"
                    : "Renames only"}
                </s-badge>
              ) : null}
              <s-text color="subdued">{`Name pattern ${productSync.nameTemplate}`}</s-text>
            </s-stack>

            <s-stack direction="inline" gap="base" alignItems="center">
              <Form method="post">
                <input type="hidden" name="intent" value="sync-catalogue" />
                <s-button
                  type="submit"
                  variant="primary"
                  {...(busy ? { disabled: true } : {})}
                >
                  Sync products with MetaKocka
                </s-button>
              </Form>
              <s-link href="/app/products/sync">Product sync settings</s-link>
            </s-stack>
            {productSync.enabled ? null : (
              <s-text color="subdued">
                Sending names is off. Turn it on in the product sync settings;
                nothing is written to MetaKocka until you do.
              </s-text>
            )}
          </s-stack>
        </s-section>

        {counts.unmatched > 0 ? (
          <s-section heading="SKUs without a MetaKocka product">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                These Shopify SKUs have no MetaKocka product with the same code,
                so their stock is not synced and orders for them cannot be sent
                to the ERP. Either add the product in MetaKocka with a matching
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

        <s-section heading="Stock">
          <s-paragraph>
            Quantities are not set here. Each location decides which side is
            counted, on the Locations page.
          </s-paragraph>
          <s-link href="/app/settings/supply-sources">Go to Locations</s-link>
        </s-section>

        <s-section heading="Recent activity">
          <RecentActivity
            items={recent}
            empty="The catalogue has not been read yet."
          />
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
