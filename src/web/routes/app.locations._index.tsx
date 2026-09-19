import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import {
  appendEvent,
  recentEvents,
} from "~/adapters/db/repositories/event-log.server";
import {
  isConnected,
  requireCredential,
} from "~/adapters/db/repositories/metakocka-credential.server";
import { listProfitCenters } from "~/adapters/db/repositories/profit-center.server";
import { getSupplyDefaults } from "~/adapters/db/repositories/supply-setting.server";
import {
  listSupplySources,
  replaceCachedWarehouses,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { DistributionBars } from "~/web/components/distribution-bars";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeEvent, describeSyncBriefly } from "~/web/lib/activity";
import { formatDateTime } from "~/web/lib/datetime";
import { loadLocationRows } from "~/web/lib/locations.server";
import {
  METAKOCKA_REGISTERS_URL,
  METAKOCKA_WAREHOUSES_URL,
} from "~/web/lib/metakocka-links";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Locations: connect each Shopify location to a MetaKocka warehouse, and run
 * the stock sync that follows.
 *
 * ## Why this lists locations
 *
 * It used to list MetaKocka warehouses, which is how the data is shaped and not
 * how the work is. A merchant fulfils orders from Shopify locations; the
 * warehouse is the ERP's name for the same shelf. Listing warehouses put the
 * answer to "is my Berlin stock syncing?" somewhere in a column of marks like
 * `GLAVNO`, and a location nobody had connected did not appear at all, which is
 * the case most worth showing. Locations lead now. Warehouses with nowhere to
 * go are a short section underneath.
 *
 * ## Why the settings are shop-level with per-location overrides
 *
 * Where stock is counted is one answer for most stores, and the old screen
 * asked it once per warehouse next to a free text profit centre field. Both now
 * live under "Stock" at the top. A location inherits them unless it says
 * otherwise, which `supply_setting` and the two inheritance flags on
 * `supply_source` hold between them (CLAUDE.md section 7).
 *
 * The effective value stays materialised on the source, so the sync engine and
 * the order writer read one column and resolve nothing.
 *
 * ## Why the profit centre is a register
 *
 * MetaKocka refuses a whole document over a profit centre it does not
 * recognise (section 3), and it will neither list them nor validate one. A free
 * text field therefore failed on an order days later, a long way from the
 * screen where the typo was made. The register in `metakocka_profit_center` is
 * checked as each entry is added, so every field that needs one is a choice.
 *
 * Nothing here waits on MetaKocka during a page load (section 2.5). Warehouses,
 * profit centres and stock all come from our own tables, refreshed by
 * background jobs. The two places that do call MetaKocka are buttons a merchant
 * pressed, not renders.
 */

/** What the sync-inventory job writes to the event log. */
const STOCK_EVENTS = [
  "inventory.synced",
  "inventory.written_to_metakocka",
  "inventory.sync_skipped",
];

/** How one location's stock sync is going, in one word. */
type LocationStatus = "not_connected" | "syncing" | "paused" | "error";

/** Long enough that reloading the page a few times sends one job, not five. */
const REFRESH_THROTTLE_SECONDS = 5 * 60;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [sources, connected, events, defaults, profitCenters] =
    await Promise.all([
      listSupplySources(principal),
      isConnected(principal),
      recentEvents(principal, 120),
      getSupplyDefaults(principal),
      listProfitCenters(principal),
    ]);

  const nameBySourceId = new Map(
    sources.map((source) => [source.id, source.name]),
  );

  // Most recent stock event per supply source. `recentEvents` is newest first,
  // so the first one seen for a source is the one to show.
  const stockEvents = events.filter((event) =>
    STOCK_EVENTS.includes(event.event),
  );
  const lastBySourceId = new Map<
    string,
    { at: string; text: string; ok: boolean }
  >();
  for (const event of stockEvents) {
    if (!event.entityId || lastBySourceId.has(event.entityId)) continue;
    const brief = describeSyncBriefly({
      event: event.event,
      detail: event.detail,
    });
    lastBySourceId.set(event.entityId, {
      at: event.at.toISOString(),
      text: brief.text,
      ok: brief.ok,
    });
  }

  const { locations: locationRows, unconnected, syncedAt } =
    await loadLocationRows(admin, principal, lastBySourceId);

  /**
   * Check the register once when nothing in it has ever been checked.
   *
   * Values carried over from the free text field this replaced arrive
   * unvalidated, and the nightly job may be twenty hours away. Enqueued, never
   * awaited: each check is a MetaKocka round trip and no page load may wait on
   * one (section 2.5).
   */
  const unchecked = profitCenters.some((entry) => entry.validatedAt === null);
  let checking = false;
  if (connected && unchecked) {
    await enqueueThrottled(
      QUEUES.reloadProfitCenters,
      { shopDomain: principal.shopDomain },
      `profit-centers:${principal.shopDomain}`,
      REFRESH_THROTTLE_SECONDS,
    );
    checking = true;
  }

  return {
    connected,
    defaults: {
      direction: String(defaults.defaultStockDirection),
      profitCenter: defaults.defaultProfitCenter ?? "",
    },
    profitCenters: profitCenters.map((entry) => ({
      value: entry.value,
      isValid: entry.isValid,
      checked: entry.validatedAt !== null,
    })),
    checking,
    locations: locationRows,
    unconnected,
    syncing: locationRows.filter((row) => row.status === "syncing").length,
    recent: stockEvents.slice(0, 6).map((event) => {
      const described = describeEvent(
        { event: event.event, detail: event.detail },
        nameBySourceId,
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
    syncedAt,
  };
};

/**
 * Which part of the screen a result belongs to.
 *
 * A save that fails inside a dialog has to say so inside that dialog: the page
 * banner behind it is not something the merchant can read or reach while it is
 * open (section 2.8).
 */
type ResultScope = "page" | "defaults" | "location" | "register";

interface ActionResult {
  ok: boolean;
  scope: ResultScope;
  message: string;
  /** Set when a location save failed, so only that dialog shows it. */
  locationId?: string | null;
  /** True for a result that succeeded but needs saying out loud. */
  warn?: boolean;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const fail = (scope: ResultScope, message: string): ActionResult => ({
    ok: false,
    scope,
    message,
  });

  /* ---------------------------------------------------------------------- */
  /* Reload the warehouse list                                              */
  /* ---------------------------------------------------------------------- */

  if (intent === "refresh-warehouses") {
    const access = await requireCredential(principal);
    if (!access.ok) {
      return fail(
        "page",
        access.reason === "not_permitted"
          ? access.message
          : "Connect MetaKocka first. The warehouse list comes from there.",
      );
    }
    const credential = access.credential;

    try {
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 15_000 },
      );
      const warehouses = await listWarehouses(client);

      const { retired, renamed } = await replaceCachedWarehouses(
        principal,
        warehouses.map((w) => ({
          mkId: w.mkId,
          mark: w.mark,
          name: w.name,
          isMain: w.isMain,
          isActive: w.isActive,
          includeInStockInfo: w.includeInStockInfo,
        })),
      );

      if (retired.length > 0) {
        await appendEvent(principal, {
          entityType: "supply_source",
          event: "warehouse_mapping.retired",
          detail: { names: retired },
        });
      }

      const parts = [
        `Found ${warehouses.length} ${warehouses.length === 1 ? "warehouse" : "warehouses"}.`,
      ];
      if (renamed.length > 0) {
        parts.push(
          `Followed ${renamed.length === 1 ? "a rename" : `${renamed.length} renames`}.`,
        );
      }
      if (retired.length > 0) {
        parts.push(
          `${retired.join(", ")} left MetaKocka, so ${retired.length === 1 ? "its" : "their"} sync stopped.`,
        );
      }

      return { ok: true, scope: "page" as const, message: parts.join(" ") };
    } catch (error) {
      if (error instanceof MetakockaError) {
        return fail("page", describeForMerchant(error));
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Re-check the profit centre register                                    */
  /* ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------- */
  /* Sync stock now                                                         */
  /* ---------------------------------------------------------------------- */

  if (intent === "sync") {
    // Queued, never awaited: a stock sync reads every connected warehouse in
    // MetaKocka and can take minutes (section 2.5).
    const jobId = await enqueueThrottled(
      QUEUES.syncInventory,
      { shopDomain: principal.shopDomain },
      `inventory:${principal.shopDomain}`,
      30,
    );

    return {
      ok: true,
      scope: "page" as const,
      message: jobId
        ? "Syncing stock in the background. Reload in a minute."
        : "A sync is already running. Its result appears below.",
    };
  }

  /*
   * Connecting and editing a location moved to the settings page with the rest
   * of what a merchant changes. This page reads.
   */
  return fail("page", "That action is not available. Reload the page.");
};

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The badge marking whichever side is counted.
 *
 * A column of its own said the same thing twice: the two systems are already
 * named across the top of the table, so a cell reading "MetaKocka" only
 * repeated the header two columns to its left. One badge, on the side that
 * wins, says it once and can be scanned down the table.
 *
 * `info` because Status owns green, amber and red on this row, and a blue chip
 * cannot be mistaken for one of those. Nothing is marked when neither side is
 * counted, which is the honest reading of "do not sync stock".
 */
function SourceBadge() {
  return <s-badge tone="info">Source</s-badge>;
}

const STATUS_LABEL: Record<LocationStatus, string> = {
  not_connected: "Not connected",
  syncing: "Syncing",
  paused: "Sync paused",
  error: "Sync error",
};

/**
 * Status only, never direction.
 *
 * `caution` is this component set's amber tone, which is what Polaris React
 * calls `attention`. There is no `attention` on `s-badge`.
 */
const STATUS_TONE: Record<
  LocationStatus,
  "caution" | "success" | "neutral" | "critical"
> = {
  not_connected: "caution",
  syncing: "success",
  paused: "neutral",
  error: "critical",
};

/** "25 Aug, 00:36". A caption, not a sentence. */
function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const HELP_MODAL_ID = "about-locations";

export default function Locations() {
  const {
    connected,
    profitCenters,
    locations,
    unconnected,
    syncing,
    recent,
    syncedAt,
  } = useLoaderData<typeof loader>();

  /**
   * One fetcher: the two buttons on this page. Everything a merchant changes
   * about a location happens on the settings page now.
   *
   * Nothing here is a submittable `<Form>`. The page this replaced held several,
   * and a form that can be submitted by anything other than a person pressing a
   * button eventually is: the event log showed saves nobody asked for.
   */
  const pageFetcher = useFetcher<typeof action>();

  const busy = pageFetcher.state !== "idle";

  const [showUnconnected, setShowUnconnected] = useState(false);

  useEffect(() => {
    const result = pageFetcher.data;
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [pageFetcher.data]);

  /* --- Derived ----------------------------------------------------------- */

  /*
   * How the store's locations stand. Ordered by how much they want a person:
   * failing first, then not connected, then the ordinary two. A status nobody
   * is in is left out rather than drawn as a zero.
   */
  const statusBreakdown = (
    [
      ["error", "Failing"],
      ["not_connected", "Not connected to a warehouse"],
      ["syncing", "Syncing"],
      ["paused", "Connected, not syncing"],
    ] as const
  )
    .map(([status, name]) => ({
      name,
      count: locations.filter((row) => row.status === status).length,
    }))
    .filter((row) => row.count > 0);

  const rejected = profitCenters.filter((entry) => !entry.isValid);

  const pageResult =
    pageFetcher.data?.scope === "page" ? pageFetcher.data : null;

  return (
    <s-page heading="Locations">
      <s-link slot="breadcrumb-actions" href="/app/metakocka">
        MetaKocka
      </s-link>

      {/*
       * Settings in the header, the same as Products. This page is what stock
       * is doing; the settings page is what every location was told to do
       * unless it says otherwise.
       */}
      <s-button
        slot="secondary-actions"
        icon="settings"
        href="/app/locations/settings"
      >
        Settings
      </s-button>

      {/*
       * Page-level explanation behind a header action rather than a card: it is
       * read once, and after that it is in the way.
       */}
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About locations">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A Shopify location holds stock, and so does a MetaKocka warehouse.
            Connecting the two tells this app where a product is.
          </s-paragraph>
          <s-link href={METAKOCKA_WAREHOUSES_URL} target="_blank">
            Open warehouses in MetaKocka
          </s-link>
          <s-paragraph>
            Stock answers where you count it. Each location follows that unless
            you change it.
          </s-paragraph>
          <s-paragraph>
            Stock is never copied both ways. The side you count wins, and the
            other is set to match.
          </s-paragraph>
          <s-paragraph>
            A location with no warehouse is ignored. Nothing is copied and no
            orders are sent.
          </s-paragraph>
          <s-paragraph>
            Profit centres live in MetaKocka, under Settings and Registers.
            MetaKocka cannot list them, so add them yourself.
          </s-paragraph>
          <s-link href={METAKOCKA_REGISTERS_URL} target="_blank">
            Open registers in MetaKocka
          </s-link>
          <s-paragraph>
            Each one is checked against MetaKocka before it is saved.
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
        {/*
         * One page-level banner at a time, so two never sit together (section
         * 2.8), ordered by urgency: something the merchant just did, then the
         * profit centres that will refuse an order, then the ones nobody has
         * been able to check. Dialog errors are not in this chain -- they
         * belong inside the dialog that raised them.
         */}
        {pageResult && !pageResult.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{pageResult.message}</s-paragraph>
          </s-banner>
        ) : rejected.length > 0 ? (
          /*
           * A profit centre MetaKocka no longer has refuses orders, so it stays
           * visible here even though the register itself moved to Settings. The
           * button goes there rather than opening a dialog this page no longer
           * owns — the register is a setting, and it is edited where the
           * settings are.
           *
           * The quieter "nothing in the register has been checked" notice went
           * with it: that is housekeeping, and it belongs on the page that
           * keeps house.
           */
          <s-banner tone="warning" heading="Profit centres to check">
            <s-paragraph>
              {`MetaKocka no longer has ${rejected.map((entry) => entry.value).join(", ")}. Orders using ${rejected.length === 1 ? "it" : "them"} will be refused.`}
            </s-paragraph>
            <s-button slot="primary-action" href="/app/locations/settings">
              Open the register
            </s-button>
          </s-banner>
        ) : null}

        {/* --- Stock sync -------------------------------------------------- */}

        <s-section heading="Stock sync">
          {/*
           * Not being connected is an exception and keeps its badge; the counts
           * do not, because a breakdown says more than one of them can.
           */}
          {connected ? null : (
            <s-badge slot="secondary-actions" tone="caution">
              MetaKocka not connected
            </s-badge>
          )}

          <s-stack direction="block" gap="base">
            {/*
             * Where the locations stand, as a breakdown rather than one count
             * in the header and the rest left to be worked out from the table
             * below. The same component Products and the home page use, so a
             * breakdown looks the same wherever this app draws one.
             *
             * Each count appears once: the table states which locations, this
             * states how many, and neither repeats the other.
             */}
            <DistributionBars
              rows={statusBreakdown}
              unit="location"
              empty="This store has no locations yet."
            />

            <s-paragraph>
              Syncing copies quantities in the background. It also runs on a
              schedule.
            </s-paragraph>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="primary"
                onClick={() =>
                  pageFetcher.submit({ intent: "sync" }, { method: "post" })
                }
                {...(busy || !connected || syncing === 0
                  ? { disabled: true }
                  : {})}
              >
                Sync stock now
              </s-button>
              <s-button
                variant="secondary"
                onClick={() =>
                  pageFetcher.submit(
                    { intent: "refresh-warehouses" },
                    { method: "post" },
                  )
                }
                {...(busy || !connected ? { disabled: true } : {})}
              >
                Reload warehouse list
              </s-button>
            </s-stack>
            <s-text color="subdued">
              {syncedAt
                ? `Warehouse list loaded ${formatDateTime(syncedAt)}.`
                : "Warehouse list not loaded yet."}
            </s-text>
          </s-stack>
        </s-section>

        {/* --- Stock ------------------------------------------------------- */}

        {/* --- Locations --------------------------------------------------- */}

        <s-section heading="Your locations">
          {locations.length === 0 ? (
            <s-paragraph>
              This store has no locations. Add one in Shopify settings first.
            </s-paragraph>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                {/*
                 * The two sides get a column each and are named in full.
                 * Stacked in one cell, the second line could be read as a
                 * subtitle of the first, and the one thing this row has to
                 * make obvious is which name belongs to which system.
                 */}
                <s-table-header listSlot="primary">
                  Shopify location
                </s-table-header>
                <s-table-header listSlot="labeled">
                  MetaKocka warehouse
                </s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
                <s-table-header listSlot="labeled">Action</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {locations.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-stack
                          direction="inline"
                          gap="small-300"
                          alignItems="center"
                        >
                          <s-text type="strong">{row.name}</s-text>
                          {row.direction === "shopify_to_mk" ? (
                            <SourceBadge />
                          ) : null}
                        </s-stack>
                        {/*
                          * A failure says what went wrong, not that something
                          * did. §2.8 asks an error to be actionable, and
                          * "MetaKocka rejected the request: Internal server
                          * error." at least sends the merchant to the right
                          * side of the integration.
                          */}
                        {row.syncMessage ? (
                          <s-text color="subdued" tone="critical">
                            {`${row.syncFailures} failed ${row.syncFailures === 1 ? "attempt" : "attempts"}${
                              row.syncCheckedAt
                                ? `, last ${shortDateTime(row.syncCheckedAt)}`
                                : ""
                            } — ${row.syncMessage}`}
                          </s-text>
                        ) : row.lastSync ? (
                          <s-text
                            color="subdued"
                            tone={row.lastSync.ok ? "auto" : "caution"}
                          >
                            {`${row.lastSync.text} · ${shortDateTime(row.lastSync.at)}`}
                          </s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>

                    {/*
                     * The mark rides along under the name, the way the payments
                     * page keeps the raw gateway handle: the mark is what goes
                     * on a MetaKocka document, so anyone reconciling against
                     * the ERP needs the exact string and not only a label.
                     */}
                    <s-table-cell>
                      {row.warehouseName ? (
                        <s-stack direction="block" gap="small-500">
                          <s-stack
                            direction="inline"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-text>{row.warehouseName}</s-text>
                            {row.direction === "mk_to_shopify" ? (
                              <SourceBadge />
                            ) : null}
                          </s-stack>
                          <s-text color="subdued">{row.warehouseMark}</s-text>
                        </s-stack>
                      ) : (
                        <s-text color="subdued">None</s-text>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[row.status]}>
                        {STATUS_LABEL[row.status]}
                      </s-badge>
                    </s-table-cell>

                    {/*
                     * Edit goes to the settings page, opening this location
                     * there. Editing a mapping is changing a setting, and it
                     * happens where the settings are — the alternative is one
                     * page that both reports and edits, which is the split this
                     * area was given for a reason.
                     */}
                    <s-table-cell>
                      <s-button
                        variant="secondary"
                        accessibilityLabel={`Edit ${row.name}`}
                        href={`/app/locations/settings?location=${encodeURIComponent(row.id)}`}
                      >
                        Edit
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        {/* --- Warehouses with nowhere to go -------------------------------- */}

        {unconnected.length === 0 ? null : (
          <s-section heading="MetaKocka warehouses not connected">
            <s-stack direction="block" gap="base">
              <s-button
                type="button"
                variant="secondary"
                icon={showUnconnected ? "chevron-up" : "chevron-down"}
                onClick={() => setShowUnconnected((open) => !open)}
                accessibilityLabel={
                  showUnconnected
                    ? "Hide the warehouses that are not connected"
                    : "Show the warehouses that are not connected"
                }
              >
                {unconnected.length === 1
                  ? "1 warehouse"
                  : `${unconnected.length} warehouses`}
              </s-button>

              {showUnconnected ? (
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Warehouse
                    </s-table-header>
                    <s-table-header listSlot="labeled">Action</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {unconnected.map((warehouse) => (
                      <s-table-row key={warehouse.mark}>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">{warehouse.name}</s-text>
                            <s-stack
                              direction="inline"
                              gap="small-300"
                              alignItems="center"
                            >
                              {warehouse.isMain ? (
                                <s-badge tone="info">Main</s-badge>
                              ) : null}
                              {warehouse.isActive ? null : (
                                <s-badge tone="caution">Inactive</s-badge>
                              )}
                            </s-stack>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-button
                            variant="secondary"
                            accessibilityLabel={`Connect ${warehouse.name}`}
                            href={`/app/locations/settings?connect=${encodeURIComponent(warehouse.mark)}`}
                          >
                            Connect
                          </s-button>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              ) : null}
            </s-stack>
          </s-section>
        )}

        <s-section heading="Recent activity">
          <RecentActivity
            items={recent}
            empty="No stock has been synced yet. The first sync appears here."
          />
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
