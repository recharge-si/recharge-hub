import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import { countByStatus, listSkus } from "~/adapters/db/repositories/sku.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { listVariantDetails } from "~/adapters/shopify/products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  nameFor,
  settingsFromTemplate,
  usesMetafields,
} from "~/domain/products/template";
import { RecentActivity } from "~/web/components/recent-activity";
import { SyncStatus } from "~/web/components/sync-status";
import { describeEvent } from "~/web/lib/activity";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Products: which Shopify SKUs have a MetaKocka product behind them.
 *
 * Built to be read rather than studied. The page answers three questions in
 * order — is it working, is anything wrong, what will it do — and everything
 * that is an explanation rather than an answer lives behind Help
 * (`docs/ui-conventions.md`), the same as the locations and payment type pages.
 *
 * Stock is not here. A quantity only means something once a warehouse has been
 * connected to a location, so it is one line pointing at that page rather than
 * a card of its own.
 *
 * Reading the catalogue queues a background job and returns immediately (§2.5):
 * MetaKocka has no bulk endpoint, so the read is slow and no request waits on
 * it. What this page shows comes from our database.
 */
const HELP_MODAL_ID = "about-products";

/** Events that say something about product sync, newest first. */
const SYNC_EVENTS = new Set([
  "catalogue.synced",
  "products.synced",
  "products.sync_skipped",
]);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [counts, unmatched, events, productSync] = await Promise.all([
    countByStatus(principal),
    listSkus(principal, "unmatched", 10),
    recentEvents(principal, 60),
    getProductSyncSetting(principal),
  ]);

  /*
   * One of the merchant's own products, named the way the sync would name it.
   *
   * The pattern itself is syntax and never reaches this page — a merchant
   * reading "{title}[ {options}]" learns nothing about their catalogue. The
   * resolved name does. It goes through `nameFor`, the same entry point the
   * job uses, and reads metafields only when the pattern needs them.
   */
  const naming = settingsFromTemplate(productSync.nameTemplate);
  const [sample] = await listVariantDetails(admin, {
    first: 1,
    maxPages: 1,
    metafields: usesMetafields(naming),
  });

  const described = events
    .filter((event) => SYNC_EVENTS.has(event.event))
    .map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      ...describeEvent({ event: event.event, detail: event.detail }),
    }));

  const latest = described[0] ?? null;

  return {
    counts,
    productSync: {
      enabled: productSync.enabled,
      createMissing: productSync.createMissing,
      namePolicy: productSync.namePolicy,
      exampleName: sample ? nameFor(naming, sample).name : null,
      exampleSku: sample?.sku ?? null,
      lastRunAt: productSync.lastRunAt?.toISOString() ?? null,
    },
    status: latest ? { at: latest.at, text: latest.text, ok: latest.ok } : null,
    unmatched: unmatched.map((row) => ({
      id: row.id,
      sku: row.sku,
      title: row.title,
    })),
    recent: described.slice(0, 6),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  if (String(formData.get("intent") ?? "") !== "sync") {
    return { ok: false, message: "Unknown action." };
  }

  /*
   * One button, one job. The catalogue read matches both sides and then queues
   * the name write itself when that is turned on, so the merchant never has to
   * know there are two jobs or which order they go in.
   */
  const jobId = await enqueueThrottled(
    QUEUES.syncCatalogue,
    { shopDomain: principal.shopDomain },
    `catalogue:${principal.shopDomain}`,
    30,
  );

  return {
    ok: true,
    message: jobId
      ? "Syncing in the background. This page updates when it finishes."
      : "A sync is already running. Waiting for it to finish.",
  };
};

const POLICY_SUMMARY: Record<string, string> = {
  always: "Names are kept up to date",
  when_empty: "Only nameless products are named",
  never: "Existing products are never renamed",
};

export default function Products() {
  const { counts, unmatched, recent, productSync, status } =
    useLoaderData<typeof loader>();
  /*
   * A fetcher rather than a form, like the locations page. There is nothing on
   * this page that can submit itself, and pressing Sync does not navigate away
   * from what the merchant was reading.
   */
  const syncer = useFetcher<typeof action>();
  const result = syncer.data;
  const busy = syncer.state !== "idle";

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

      {/*
       * The explanation behind a header action, the same as the payment types
       * and locations pages: it is read once, and after that it is in the way.
       */}
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every Shopify variant with a SKU is matched to the MetaKocka product
            that has the same code. Only a matched product can have its stock
            synced or appear on an order sent to MetaKocka.
          </s-paragraph>
          <s-paragraph>
            Syncing reads both catalogues and matches them. If sending names is
            on, it then writes your names into MetaKocka and can create a
            product for a SKU MetaKocka does not have.
          </s-paragraph>
          <s-paragraph>
            To fix an unmatched SKU, either add the product in MetaKocka with a
            matching code, or correct the SKU in Shopify.
          </s-paragraph>
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

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <SyncStatus
          title="Product sync"
          healthy={status ? status.ok : true}
          {...(status && !status.ok ? { problem: status.text } : {})}
          lastRunAt={status?.at ?? productSync.lastRunAt}
          outcome={status?.text ?? null}
          cadence="Runs when you press Sync products."
          action={{
            label: "Open product sync settings",
            href: "/app/products/sync",
          }}
        />

        <s-section heading="Matching">
          <s-stack direction="block" gap="base">
            {/* One count, stated once. The total is part of the sentence. */}
            <s-text>
              {total === 0
                ? "No SKUs have been read yet."
                : `${counts.matched} of ${total} SKUs are matched to a MetaKocka product.`}
            </s-text>

            <s-button
              type="button"
              variant="primary"
              onClick={() =>
                syncer.submit({ intent: "sync" }, { method: "post" })
              }
              {...(busy ? { disabled: true, loading: true } : {})}
            >
              Sync products
            </s-button>
          </s-stack>
        </s-section>

        {/*
         * A zero does not render at all. A non-zero one is the loudest thing on
         * the page and the records it is about sit directly under it, so
         * "which ones" needs no link to answer (docs/ui-conventions.md).
         */}
        {counts.unmatched > 0 ? (
          <s-section
            heading={`${counts.unmatched} ${counts.unmatched === 1 ? "SKU has" : "SKUs have"} no MetaKocka product`}
          >
            <s-stack direction="block" gap="base">
              <s-banner tone="warning">
                <s-paragraph>
                  Their stock is not synced, and an order for one of them cannot
                  be sent to MetaKocka.
                </s-paragraph>
              </s-banner>
              <s-unordered-list>
                {unmatched.map((row) => (
                  <s-list-item key={row.id}>
                    {row.sku}
                    {row.title ? ` — ${row.title}` : ""}
                  </s-list-item>
                ))}
              </s-unordered-list>
              {counts.unmatched > unmatched.length ? (
                <s-text color="subdued">
                  {`Showing ${unmatched.length} of ${counts.unmatched}.`}
                </s-text>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        <s-section heading="What the sync will do">
          <s-stack direction="block" gap="base">
            {/*
             * A summary line, not badges. These are settings the merchant
             * chooses, and a pill reads as a status they cannot change
             * (docs/ui-conventions.md).
             */}
            {productSync.enabled ? (
              <s-stack direction="block" gap="small-400">
                <s-text>
                  {POLICY_SUMMARY[productSync.namePolicy] ??
                    POLICY_SUMMARY.always}
                  {productSync.createMissing
                    ? ", and missing products are created."
                    : ". Missing products are not created."}
                </s-text>
                {productSync.exampleName ? (
                  <s-text color="subdued">
                    {`${productSync.exampleSku} would be called “${productSync.exampleName}” in MetaKocka.`}
                  </s-text>
                ) : null}
              </s-stack>
            ) : (
              <s-text>
                Names are not sent to MetaKocka. Matching still runs.
              </s-text>
            )}

            <s-link href="/app/products/sync">
              Change product sync settings
            </s-link>
          </s-stack>
        </s-section>

        {/* A pointer, so a line rather than a card. */}
        <s-text color="subdued">
          Stock is set per location, on the{" "}
          <s-link href="/app/settings/supply-sources">Locations</s-link> page.
        </s-text>

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
