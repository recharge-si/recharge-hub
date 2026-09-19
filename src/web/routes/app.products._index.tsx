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
import {
  countByStatus,
  listSkuPage,
} from "~/adapters/db/repositories/sku.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { listVariantDetails } from "~/adapters/shopify/products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  nameFor,
  settingsFromTemplate,
  usesMetafields,
} from "~/domain/products/template";
import { DistributionBars } from "~/web/components/distribution-bars";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeEvent } from "~/web/lib/activity";
import { formatDateTime, formatInterval } from "~/web/lib/datetime";
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

/**
 * How many unmatched SKUs to name before the count speaks for itself.
 *
 * This is a warning, not a browser. Past a couple of dozen the useful sentence
 * is "twelve hundred of your SKUs are not in MetaKocka", and listing them all
 * would bury it.
 */
const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [counts, rows, events, productSync] = await Promise.all([
    countByStatus(principal),
    /*
     * One row more than fits, which is the whole of the pagination state: if it
     * came back there is a next page. A count query would double the work to
     * answer a question the extra row already answers.
     */
    listSkuPage(principal, { status: "unmatched", take: PAGE_SIZE }),
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
    products: rows,
    productSync: {
      enabled: productSync.enabled,
      createMissing: productSync.createMissing,
      namePolicy: productSync.namePolicy,
      exampleName: sample ? nameFor(naming, sample).name : null,
      exampleSku: sample?.sku ?? null,
      lastRunAt: productSync.lastRunAt?.toISOString() ?? null,
      scheduleEnabled: productSync.scheduleEnabled,
      scheduleIntervalMinutes: productSync.scheduleIntervalMinutes,
    },
    status: latest ? { at: latest.at, text: latest.text, ok: latest.ok } : null,
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
  const { counts, products, recent, productSync, status } =
    useLoaderData<typeof loader>();
  /*
   * A fetcher rather than a form, like the locations page. There is nothing on
   * this page that can submit itself, and pressing Sync does not navigate away
   * from what the merchant was reading.
   */
  const syncer = useFetcher<typeof action>();
  const result = syncer.data;
  const busy = syncer.state !== "idle";
  const lastRunAt = status?.at ?? productSync.lastRunAt;

  /*
   * How the catalogue divides. A row that is zero is left out rather than
   * drawn empty: "0 ignored" is not a fact anybody came here for, and an
   * unmatched row of zero is the good news the card's own silence already
   * carries.
   */
  const breakdown = [
    { name: "Matched to a MetaKocka product", count: counts.matched },
    { name: "Not matched", count: counts.unmatched },
    { name: "Ignored", count: counts.ignored },
  ].filter((row) => row.count > 0);

  // Confirmations are toasts, like the rest of the admin. Failures stay on the
  // page as a banner, because section 2.8 requires errors to persist.
  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="Products">
      <s-link slot="breadcrumb-actions" href="/app/metakocka">
        MetaKocka
      </s-link>

      {/*
       * Settings in the header, where a merchant looks for it, rather than only
       * at the foot of the card that summarises it. This page is what is
       * happening; the settings page is what it was told to do.
       */}
      <s-button
        slot="secondary-actions"
        icon="settings"
        href="/app/products/sync"
      >
        Settings
      </s-button>

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
            Syncing reads both catalogues and matches them. If product sync is
            on, it then writes your names into MetaKocka, and can create a
            product for a SKU MetaKocka does not have and keep prices up to
            date.
          </s-paragraph>
          <s-paragraph>
            To fix an unmatched SKU, either add the product in MetaKocka with a
            matching code, or correct the SKU in Shopify.
          </s-paragraph>
          <s-paragraph>
            Stock is not set here. Each location decides which side is counted.
          </s-paragraph>
          <s-link href="/app/locations">Go to Locations</s-link>
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

        {status && !status.ok ? (
          <s-banner tone="warning" heading="The last sync had a problem">
            <s-paragraph>{status.text}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Matching">
          <s-stack direction="block" gap="base">
            {/*
             * The catalogue as a breakdown rather than a sentence: how many
             * SKUs there are, and how they divide. Each number appears once —
             * the bars are the count, so there is no summary line restating
             * them above (docs/ui-conventions.md).
             *
             * The same component the home page uses for warehouse shares, so
             * two pages showing a breakdown show it the same way.
             */}
            <DistributionBars
              rows={breakdown}
              unit="SKU"
              empty="No SKUs have been read yet."
            />

            <s-stack direction="inline" gap="base" alignItems="center">
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

            {/*
             * When it last ran, and what makes it run. This said syncing
             * happens when you press the button and nothing else, which stops
             * being true the moment a merchant turns the schedule on — and the
             * page with the button was the one still claiming the button was
             * the only way.
             *
             * The cadence, not a next-run time: the tick that fires it looks
             * every quarter of an hour, and a time computed against the
             * reader's own clock is a hydration mismatch waiting to happen.
             */}
            <s-text color="subdued">
              {`${
                lastRunAt
                  ? `Last synced ${formatDateTime(lastRunAt)}.`
                  : "Not synced yet."
              } ${
                productSync.scheduleEnabled
                  ? `It also runs on its own every ${formatInterval(productSync.scheduleIntervalMinutes)}.`
                  : "Syncing runs when you press the button."
              }`}
            </s-text>
          </s-stack>
        </s-section>

        {/*
         * The unmatched SKUs, listed rather than counted.
         *
         * A full product browser lived here for a while and was the wrong page
         * for it: this screen exists to answer "is matching working", and a
         * merchant who wants to look at a product looks at it in Shopify. What
         * belongs here is the exception — the SKUs that will stop an order —
         * and the picture, price and stock that made that browser worth reading
         * now sit on the order, next to the lines they explain.
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

              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="kicker">SKU</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {products.map((product) => (
                    <s-table-row key={product.id}>
                      <s-table-cell>
                        <s-stack
                          direction="inline"
                          gap="small-300"
                          alignItems="center"
                        >
                          {/*
                            * `s-image` in a fixed box, not `s-thumbnail`: a
                            * thumbnail draws a framed tile, which reads as a
                            * missing input beside a name rather than as a
                            * picture of the thing.
                            */}
                          <s-box inlineSize="40px" blockSize="40px">
                            {product.imageUrl ? (
                              <s-image
                                src={product.imageUrl}
                                alt=""
                                inlineSize="fill"
                                objectFit="contain"
                                loading="lazy"
                              />
                            ) : null}
                          </s-box>
                          <s-text>{product.title ?? product.sku}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{product.sku}</s-text>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>

              {counts.unmatched > products.length ? (
                <s-text color="subdued">
                  {`Showing ${products.length} of ${counts.unmatched}.`}
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
                Nothing is written to MetaKocka. Matching still runs.
              </s-text>
            )}

            {/*
             * No button out of this card. Settings is in the page header now,
             * which is where a merchant looks for it and where every other area
             * keeps it — a second button to the same page turns the card into a
             * menu entry for a page the header already offers.
             */}
          </s-stack>
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
