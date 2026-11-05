import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getCatalogueState } from "~/adapters/db/repositories/catalogue.server";
import { getDashboard } from "~/adapters/db/repositories/dashboard.server";
import { recentEvents } from "~/adapters/db/repositories/event-log.server";
import { getProductSyncSetting } from "~/adapters/db/repositories/product-sync-setting.server";
import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import { getRigHomeFacts } from "~/adapters/db/repositories/rig.server";
import {
  countVariantStatesFor,
  listCampaigns,
} from "~/adapters/db/repositories/sale-campaign.server";
import { ensureShop, findShop } from "~/adapters/db/repositories/shop.server";
import { listSupplySources } from "~/adapters/db/repositories/supply-source.server";
import {
  getCoverage,
  listActiveSyncs,
  listLanguageSettings,
} from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { componentOf } from "~/domain/readiness";
import { HomeAttentionSection } from "~/web/components/home-attention";
import { RecentActivity } from "~/web/components/recent-activity";
import { SetupBanner } from "~/web/components/setup-banner";
import { StoreOperations } from "~/web/components/store-operations";
import { HOME_ACTIVITY_EXCLUDED, homeActivity } from "~/web/lib/activity";
import {
  homeAttention,
  salesOverview,
  storeOperations,
  translationsFacts,
} from "~/web/lib/home";
import { useLiveRevalidation } from "~/web/lib/live";
import { principalFromSession } from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { describeDiscount, formatInZone } from "~/web/lib/sales";

/**
 * The operations dashboard.
 *
 * docs/BUILD_SPEC.md section 2.7 is explicit that a static welcome card fails
 * Built for Shopify: the home page has to be dynamic and diagnostic. It
 * answers four questions, in this order, and leaves out a section with
 * nothing to say:
 *
 *  1. **Is it set up and running?** The setup banner, only until Finish
 *     setup has been pressed. A running store has no banner: healthy is calm.
 *  2. **Does anything need me?** Needs attention, one row per area with its
 *     count and a link to the records, never the records themselves.
 *  3. **How is each part doing?** Store operations: MetaKocka, orders,
 *     inventory, products, translations and sales, two or three facts each
 *     (`web/lib/home`).
 *  4. **What happened recently?** The last few events, in words, one per
 *     kind (`web/lib/activity`).
 *
 * Everything is read from our own database. Section 2.5 forbids a page load
 * awaiting MetaKocka, and nothing here calls Shopify either: coverage and
 * sync times are the stored ones the Translations pages keep. The only
 * write is the shop row a first visit creates.
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
    campaigns,
    catalogue,
    productSync,
    sources,
    coverage,
    languages,
    activeSyncs,
    rigFacts,
  ] = await Promise.all([
    getDashboard(principal, now),
    recentEvents(principal, 60, { excludePrefixes: HOME_ACTIVITY_EXCLUDED }),
    getReadiness(principal),
    listCampaigns(principal),
    getCatalogueState(principal),
    getProductSyncSetting(principal),
    listSupplySources(principal),
    getCoverage(principal),
    listLanguageSettings(principal),
    listActiveSyncs(principal),
    getRigHomeFacts(principal, now),
  ]);
  const campaignCounts = await countVariantStatesFor(
    campaigns.map((campaign) => campaign.id),
  );

  /* What an event's entity is called: a warehouse, a campaign. */
  const names = new Map<string, string>([
    ...sources.map((source) => [source.id, source.name] as [string, string]),
    ...campaigns.map(
      (campaign) => [campaign.id, campaign.name] as [string, string],
    ),
  ]);

  const timeZone = catalogue.ianaTimezone ?? "UTC";
  const sales = salesOverview(
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
  );

  return {
    readiness: {
      components: readiness.components,
      overall: readiness.overall,
      activated: readiness.activated,
    },
    attention: homeAttention(readiness, dashboard.openExceptionsByKind),
    operations: storeOperations({
      components: readiness.components,
      figures: dashboard,
      productSync: {
        enabled: productSync.enabled,
        lastRunAt: productSync.lastRunAt?.toISOString() ?? null,
      },
      translations: translationsFacts({
        coverageRows: coverage.rows,
        languages: languages.map((language) => ({
          locale: language.locale,
          lastSuccessfulSyncAt:
            language.lastSuccessfulSyncAt?.toISOString() ?? null,
        })),
        activeSyncs: activeSyncs.length,
      }),
      sales,
      rig: rigFacts
        ? {
            buildsToday: rigFacts.buildsToday,
            plain: rigFacts.plain,
            lastExhaustedAt: rigFacts.lastExhaustedAt?.toISOString() ?? null,
          }
        : null,
      timeZone,
      formatDate: formatInZone,
      now,
    }),
    activity: homeActivity(events, names),
    busy: activeSyncs.length > 0,
  };
};

export default function Home() {
  const { readiness, attention, operations, activity, busy } =
    useLoaderData<typeof loader>();

  // Faster while a translation sync runs; every thirty seconds otherwise.
  useLiveRevalidation({ active: busy });

  const needsAttention =
    attention.setup.length > 0 || attention.groups.length > 0;

  return (
    <s-page heading="Recharge Hub" inlineSize="large">
      <s-stack direction="block" gap="base">
        {/*
         * Before Finish setup, the banner is the whole of what setup has to
         * say. After it, a setting that has stopped being true is a row in
         * Needs attention — never a second banner (section 2.8).
         */}
        {!readiness.activated ? (
          <SetupBanner
            components={readiness.components}
            overall={readiness.overall}
          />
        ) : null}

        {needsAttention ? <HomeAttentionSection attention={attention} /> : null}

        <StoreOperations tiles={operations} />

        <s-section heading="Recent activity">
          <RecentActivity
            items={activity}
            initial={activity.length}
            empty="Nothing has happened yet. Activity shows up here as the app works."
          />
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
