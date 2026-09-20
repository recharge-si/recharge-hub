import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { enqueue, enqueueThrottled } from "~/adapters/queue/boss.server";
import {
  QUEUES,
  catalogueSnapshotKey,
  inventorySyncKey,
  translationCoverageKey,
} from "~/adapters/queue/queues";
import {
  abandonStaleSyncs,
  listActiveSyncs,
  listAutomaticLanguages,
} from "~/adapters/db/repositories/translations.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { captureException } from "~/adapters/observability/sentry.server";
import { startSync } from "~/adapters/translations/syncs.server";
import {
  typesForGroups,
  type ContentGroup,
  type SyncMode,
} from "~/domain/translations/types";
import { serviceToken } from "~/domain/types";

export const scheduledTickJobSchema = z.object({
  /** Which cadence fired, so one handler can serve several schedules. */
  cadence: z
    .enum(["fast", "quarter_hourly", "hourly", "nightly"])
    .default("quarter_hourly"),
});

type Cadence = z.infer<typeof scheduledTickJobSchema>["cadence"];

/**
 * Fans a cron tick out to one job per shop.
 *
 * pg-boss schedules a queue, not a tenant, so a single cron entry cannot carry
 * "for every shop". This handler is that missing step: it reads the installed
 * shops and enqueues the per-shop work, which keeps exactly one cron entry per
 * cadence in the worker however many shops are installed.
 *
 * Everything it sends is throttled. A tick that fires while the previous run is
 * still going adds nothing rather than stacking a second copy of a job that can
 * take minutes (§2.5), and each throttle window is a little longer than its
 * cadence so a slow run cannot be lapped.
 *
 * Four cadences, and the split is about consequence rather than cost:
 *
 *  - **fast (5 minutes)** — stock. It is the number that decides whether the
 *    store oversells, and it is the number that changes most often.
 *  - **quarter-hourly** — everything that keeps orders and exceptions honest.
 *  - **hourly** — reading this app's own documents back out of MetaKocka
 *    (§8.11 names the cadence, and every check is a round trip to a slow ERP).
 *  - **nightly** — the registers, whose reads are deliberate rejections (§7),
 *    and the retention promise.
 *
 * **One shop's failure is not another shop's problem.** The fan-out is a loop
 * over tenants, so an unhandled throw halfway down it used to take every shop
 * after that one with it — silently, because the tick simply failed and the
 * next one started from the top and threw at the same place. Each shop is
 * therefore isolated, and a failure is reported rather than propagated: the
 * tick's own job is only to send, and it has sent everything it could.
 */
export async function handleScheduledTick(job: Job<unknown>): Promise<void> {
  const { cadence } = scheduledTickJobSchema.parse(job.data ?? {});
  const log = getLogger();

  // Only shops that are installed and have credentials. Everything downstream
  // needs MetaKocka, so sending jobs for a shop without a key would just queue
  // work that returns immediately.
  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      installState: "installed",
      metakockaCredential: { isNot: null },
    },
    select: {
      domain: true,
      productSyncSetting: {
        select: {
          scheduleEnabled: true,
          scheduleIntervalMinutes: true,
          lastRunAt: true,
        },
      },
    },
  });

  const now = Date.now();

  let failed = 0;

  for (const shop of shops) {
    try {
      await fanOutForShop(shop, cadence, now);
    } catch (error) {
      failed += 1;
      log.error(
        { err: error, shop: shop.domain, cadence },
        "Could not fan the scheduled tick out for one shop",
      );
      captureException(error, { shop: shop.domain, cadence });
    }
  }

  log.info(
    { shops: shops.length, failed, cadence },
    "Scheduled tick fanned out",
  );

  await fanOutCatalogueSnapshots(cadence);
  await fanOutTranslations(cadence);
}

/**
 * Automatic translation (docs/translations.md § Automatic translation).
 *
 * Its own fan-out too, for the same reason as the catalogue: translation
 * needs Shopify and OpenAI, not MetaKocka. Nightly, every language with
 * automatic translation on gets one `automatic` sync over its content scope
 * — missing fields, and outdated ones where the language asks — which is
 * what catches the collections, pages and articles no webhook reports, and
 * anything a webhook missed. The coverage cache is re-read nightly for every
 * installed shop so the Languages page is never more than a day old.
 *
 * Quarter-hourly, syncs whose job died for good are marked failed rather
 * than shown as running for ever.
 */
async function fanOutTranslations(cadence: Cadence): Promise<void> {
  const log = getLogger();

  if (cadence === "quarter_hourly") {
    const stale = new Date(Date.now() - STALE_SYNC_MS);
    const abandoned = await abandonStaleSyncs(stale, new Date());
    if (abandoned > 0)
      log.warn({ abandoned }, "Translation syncs given up on");
    return;
  }
  if (cadence !== "nightly") return;

  const languages = await listAutomaticLanguages();
  const byShop = new Map<string, typeof languages>();
  for (const language of languages) {
    byShop.set(language.shopDomain, [
      ...(byShop.get(language.shopDomain) ?? []),
      language,
    ]);
  }
  for (const [shopDomain, rows] of byShop) {
    const principal = serviceToken(shopDomain, "scheduled-tick");
    try {
      // The store's primary locale is read by the sync itself; a language
      // that turns out to be primary or disabled is dropped there.
      const active = await listActiveSyncs(principal);
      if (active.some((sync) => sync.kind === "automatic")) continue;
      const byMode = new Map<SyncMode, typeof rows>();
      for (const row of rows) {
        const mode: SyncMode = row.settings.autoUpdateOutdated
          ? "missing_outdated"
          : "missing";
        byMode.set(mode, [...(byMode.get(mode) ?? []), row]);
      }
      for (const [mode, group] of byMode) {
        const scope = new Set<ContentGroup>();
        for (const row of group)
          for (const item of row.settings.contentScope) scope.add(item);
        await startSync(principal, {
          kind: "automatic",
          mode,
          sourceLocale: "",
          targetLocales: group.map((row) => row.settings.locale),
          resourceTypes: typesForGroups([...scope]),
          requestedBy: null,
        });
      }
    } catch (error) {
      log.error(
        { err: error, shop: shopDomain },
        "Could not start the nightly automatic translation",
      );
      captureException(error, { shop: shopDomain, cadence });
    }
  }

  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, installState: "installed" },
    select: { domain: true },
  });
  for (const shop of shops) {
    await enqueueThrottled(
      QUEUES.translationCoverage,
      { shopDomain: shop.domain },
      translationCoverageKey(shop.domain),
      20 * 60 * 60,
    );
  }
}

/** A sync untouched for this long has no job coming back for it. */
const STALE_SYNC_MS = 6 * 60 * 60_000;

/**
 * The catalogue snapshot behind sale campaigns (docs/sale-campaigns.md).
 *
 * Its own fan-out, because it does not need MetaKocka: a shop can run
 * sales without the ERP connected, and the query above deliberately skips
 * such shops. Hourly-ish for a shop with a campaign that will need a fresh
 * catalogue — a dynamic one that is active, or one waiting to start — and
 * nightly for every installed shop, so a preview is never a week old.
 */
async function fanOutCatalogueSnapshots(cadence: Cadence): Promise<void> {
  if (cadence !== "quarter_hourly" && cadence !== "nightly") return;

  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      installState: "installed",
      ...(cadence === "quarter_hourly"
        ? {
            saleCampaigns: {
              some: {
                OR: [
                  { status: "scheduled" },
                  { status: "active", dynamicMembership: true },
                ],
              },
            },
          }
        : {}),
    },
    select: { domain: true },
  });

  for (const shop of shops) {
    try {
      await enqueueThrottled(
        QUEUES.catalogueSnapshot,
        { shopDomain: shop.domain },
        catalogueSnapshotKey(shop.domain),
        cadence === "quarter_hourly" ? 55 * 60 : 20 * 60 * 60,
      );
    } catch (error) {
      getLogger().error(
        { err: error, shop: shop.domain, cadence },
        "Could not queue the catalogue snapshot for one shop",
      );
      captureException(error, { shop: shop.domain, cadence });
    }
  }
}

type TickShop = {
  domain: string;
  productSyncSetting: {
    scheduleEnabled: boolean;
    scheduleIntervalMinutes: number;
    lastRunAt: Date | null;
  } | null;
};

async function fanOutForShop(
  shop: TickShop,
  cadence: Cadence,
  now: number,
): Promise<void> {
  const { domain } = shop;

  if (cadence === "fast") {
    /*
     * Stock, every five minutes.
     *
     * MetaKocka's own webhook exists for this and gives up after two retries
     * (§3), which makes it a hint rather than a delivery guarantee. A short
     * cycle beside it is what turns "usually current" into "never more than
     * five minutes behind", and stock is the one figure where being behind
     * means selling something that is not there.
     *
     * Cheap by construction: the sync writes only what differs and skips
     * every no-op (§7).
     *
     * Deduped rather than throttled, and the key is shared with the webhook
     * that also asks for this job — see `inventorySyncKey` for why a window
     * did not actually collapse the two.
     */
    await enqueue(
      QUEUES.syncInventory,
      { shopDomain: domain },
      { singletonKey: inventorySyncKey(domain) },
    );
    return;
  }

  if (cadence === "quarter_hourly") {
    // The warehouse list is small and cheap, and a stale mark is dangerous
    // (§3), so it refreshes on every tick.
    await enqueueThrottled(
      QUEUES.reloadWarehouses,
      { shopDomain: domain },
      `warehouses:${domain}`,
      14 * 60,
    );

    /*
     * Orders, re-read from Shopify (§8.10).
     *
     * Not an optimisation and not a nightly nicety: Shopify webhooks are
     * best-effort, and a payment this app never hears about is a payment the
     * merchant chases by hand. Cheap by construction — it asks Shopify only
     * for what has changed, and an order that has not moved costs one
     * comparison.
     */
    await enqueueThrottled(
      QUEUES.reconcileOrders,
      { shopDomain: domain },
      `orders:${domain}`,
      14 * 60,
    );

    /*
     * Open exceptions, re-checked (§11).
     *
     * An exception is a condition, not an event. "Not enough stock" stops
     * being true the moment stock arrives and nothing announces it, so
     * without this the queue fills with problems that were dealt with days
     * ago — and a queue nobody trusts is a queue nobody reads.
     */
    await enqueueThrottled(
      QUEUES.recheckExceptions,
      { shopDomain: domain },
      `exceptions:${domain}`,
      14 * 60,
    );

    /*
     * The catalogue, on the merchant's own schedule.
     *
     * A registry that is only as fresh as the last time somebody pressed a
     * button is a registry that silently stops matching: a product renamed in
     * MetaKocka, a SKU corrected in Shopify, a new variant added this
     * morning. Off by default and the interval is the merchant's, because
     * this is the one scheduled job that can write into their ERP catalogue
     * (§8.9).
     */
    const productSync = shop.productSyncSetting;
    if (productSync?.scheduleEnabled) {
      const due =
        !productSync.lastRunAt ||
        now - productSync.lastRunAt.getTime() >=
          productSync.scheduleIntervalMinutes * 60 * 1000;

      if (due) {
        await enqueueThrottled(
          QUEUES.syncCatalogue,
          { shopDomain: domain },
          `catalogue:${domain}`,
          // Never more than one in flight, whatever interval was chosen.
          Math.max(5, productSync.scheduleIntervalMinutes - 1) * 60,
        );
      }
    }
  }

  if (cadence === "hourly") {
    /*
     * What MetaKocka has done with our documents since we wrote them.
     *
     * The ERP pushes nothing but stock (§3), so an order that is confirmed,
     * picked, delivered — or simply deleted — inside MetaKocka still reads as
     * "written" here unless somebody asks. §8.11 says hourly, and this used
     * to run on the quarter-hourly tick: four times the round trips into a
     * slow ERP for an answer that changes when a person does something by
     * hand.
     */
    await enqueueThrottled(
      QUEUES.pollMetakockaDocuments,
      { shopDomain: domain },
      `documents:${domain}`,
      55 * 60,
    );
  }

  if (cadence === "nightly") {
    // Nightly rather than quarter-hourly: reading the payment types means
    // sending a document that fails validation on purpose (no endpoint lists
    // them, §8.7), and a register changes a few times a year. Doing that
    // every fifteen minutes would fill the merchant's own API log with
    // rejections that are not failures.
    await enqueueThrottled(
      QUEUES.reloadPaymentTypes,
      { shopDomain: domain },
      `payment-types:${domain}`,
      20 * 60 * 60,
    );

    // Same reasoning, and the same kind of probe: re-checking a profit
    // centre means sending a document that fails on purpose (§3 has no
    // endpoint to ask). What it catches is a centre renamed in the ERP long
    // after it was registered here, which otherwise surfaces as a rejected
    // order.
    await enqueueThrottled(
      QUEUES.reloadProfitCenters,
      { shopDomain: domain },
      `profit-centers:${domain}`,
      20 * 60 * 60,
    );

    // Which pricelists and VAT rates the company's own catalogue uses.
    // MetaKocka lists neither (3), so this reads them off priced products.
    // An ordinary read rather than a deliberate rejection, but several
    // MetaKocka calls all the same, and the answer changes about as often as
    // a payment register does.
    await enqueueThrottled(
      QUEUES.reloadPricelists,
      { shopDomain: domain },
      `pricelists:${domain}`,
      20 * 60 * 60,
    );

    // Section 2.4: the retention promise is kept by a job, not by intent.
    await enqueueThrottled(
      QUEUES.redactOldOrders,
      { shopDomain: domain },
      `redact:${domain}`,
      20 * 60 * 60,
    );
  }
}
