import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
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
import {
  listProfitCenters,
  removeProfitCenter,
  saveProfitCenter,
  sourcesUsingProfitCenter,
} from "~/adapters/db/repositories/profit-center.server";
import {
  getSupplyDefaults,
  saveSupplyDefaults,
} from "~/adapters/db/repositories/supply-setting.server";
import {
  listCachedWarehouses,
  listSupplySources,
  replaceCachedWarehouses,
} from "~/adapters/db/repositories/supply-source.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { validateProfitCenter } from "~/adapters/metakocka/profit-centers";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { listLocations } from "~/adapters/shopify/locations";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import { RecentActivity } from "~/web/components/recent-activity";
import { describeDirection } from "~/domain/readiness";
import { describeEvent, describeSyncBriefly } from "~/web/lib/activity";
import { formatDateTime } from "~/web/lib/datetime";
import { INHERIT, toDirection } from "~/web/lib/locations";
import { saveLocationMapping } from "~/web/lib/locations.server";
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

  const [
    warehouses,
    sources,
    locations,
    connected,
    events,
    defaults,
    profitCenters,
  ] = await Promise.all([
    listCachedWarehouses(principal),
    listSupplySources(principal),
    listLocations(admin),
    isConnected(principal),
    recentEvents(principal, 120),
    getSupplyDefaults(principal),
    listProfitCenters(principal),
  ]);

  const warehouseByMark = new Map(warehouses.map((w) => [w.mark, w]));
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

  // A source counts as this location's connection only while its warehouse is
  // still one MetaKocka returns. A source left over from a deleted warehouse
  // syncs nothing, and showing it as connected would explain none of that.
  const sourceByLocation = new Map(
    sources
      .filter(
        (source) =>
          source.shopifyLocationId !== null &&
          source.metakockaWarehouse !== null &&
          warehouseByMark.has(source.metakockaWarehouse),
      )
      .map((source) => [source.shopifyLocationId!, source]),
  );

  const locationRows = locations.map((location) => {
    const source = sourceByLocation.get(location.id) ?? null;
    const warehouse = source?.metakockaWarehouse
      ? (warehouseByMark.get(source.metakockaWarehouse) ?? null)
      : null;
    const lastSync = source ? (lastBySourceId.get(source.id) ?? null) : null;

    /*
     * The location's own record of its last run, not the activity log.
     *
     * The log only ever had entries the job managed to write, and a run that
     * threw wrote none — so the location that had failed every attempt for nine
     * hours looked exactly like one that had never had a problem. The outcome
     * is now recorded on the location whether the run worked or not, which is
     * the only version of this that can report a failure.
     */
    const status: LocationStatus = !warehouse
      ? "not_connected"
      : source?.lastSyncOk === false
        ? "error"
        : lastSync && !lastSync.ok
          ? "error"
          : source && source.stockDirection !== "none" && source.enabled
            ? "syncing"
            : "paused";

    return {
      id: location.id,
      name: location.name,
      isActive: location.isActive,
      fulfillmentServiceName: location.fulfillmentServiceName,
      sourceId: source?.id ?? null,
      warehouseMark: warehouse?.mark ?? "",
      warehouseName: warehouse?.name ?? null,
      direction: String(source?.stockDirection ?? "none"),
      directionInherited: source?.stockDirectionInherited ?? true,
      profitCenter: source?.metakockaProfitCenter ?? "",
      profitCenterInherited: source?.profitCenterInherited ?? true,
      status,
      lastSync,
      // What went wrong and how long it has been going wrong, so the row says
      // something a merchant can act on rather than just turning red.
      syncMessage: source?.lastSyncOk === false ? source.lastSyncMessage : null,
      syncFailures: source?.syncFailures ?? 0,
      syncCheckedAt: source?.lastSyncAt?.toISOString() ?? null,
    };
  });

  const connectedMarks = new Set(
    locationRows.map((row) => row.warehouseMark).filter(Boolean),
  );

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
    unconnected: warehouses
      .filter((warehouse) => !connectedMarks.has(warehouse.mark))
      .map((warehouse) => ({
        mark: warehouse.mark,
        name: warehouse.name,
        isMain: warehouse.isMain,
        isActive: warehouse.isActive,
      })),
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
    syncedAt: warehouses[0]?.syncedAt.toISOString() ?? null,
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

  if (intent === "refresh-profit-centers") {
    const access = await requireCredential(principal);
    if (!access.ok) {
      return fail(
        "register",
        access.reason === "not_permitted"
          ? access.message
          : "Connect MetaKocka first, then check again.",
      );
    }

    // Queued rather than awaited: this is one MetaKocka round trip per entry
    // plus a control, which is minutes for a large register (section 2.5).
    await enqueueThrottled(
      QUEUES.reloadProfitCenters,
      { shopDomain: principal.shopDomain },
      `profit-centers:${principal.shopDomain}`,
      REFRESH_THROTTLE_SECONDS,
    );

    return {
      ok: true,
      scope: "register" as const,
      message: "Checking the register against MetaKocka.",
    };
  }

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

  /* ---------------------------------------------------------------------- */
  /* Sync defaults                                                          */
  /* ---------------------------------------------------------------------- */

  if (intent === "save-defaults") {
    const direction = toDirection(String(formData.get("direction") ?? "none"));
    const profitCenter =
      String(formData.get("profitCenter") ?? "").trim() || null;

    const { updated, blocked } = await saveSupplyDefaults(principal, {
      defaultStockDirection: direction,
      defaultProfitCenter: profitCenter,
    });

    await appendEvent(principal, {
      entityType: "supply_source",
      event: "supply_defaults.saved",
      detail: { direction, profitCenter, updated },
    });

    if (blocked.length > 0) {
      // Section 7: one writer per Shopify location. Saying nothing would leave
      // the merchant believing the default reached locations it did not.
      return fail(
        "defaults",
        `Saved. ${blocked.join(", ")} kept ${blocked.length === 1 ? "its" : "their"} setting, because another warehouse already writes to that location.`,
      );
    }

    return {
      ok: true,
      scope: "defaults" as const,
      message:
        updated === 0
          ? "Saved the defaults."
          : `Saved. ${updated} ${updated === 1 ? "location follows" : "locations follow"} them.`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Add or remove a profit centre                                          */
  /* ---------------------------------------------------------------------- */

  if (intent === "add-profit-center") {
    const value = String(formData.get("value") ?? "").trim();
    if (!value) {
      return fail("register", "Enter the name exactly as MetaKocka has it.");
    }

    const access = await requireCredential(principal);
    if (!access.ok) {
      return fail(
        "register",
        access.reason === "not_permitted"
          ? access.message
          : "Connect MetaKocka first, then add a centre.",
      );
    }
    const credential = access.credential;

    try {
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 30_000 },
      );
      const verdict = await validateProfitCenter(client, value);

      if (verdict === "invalid") {
        return fail(
          "register",
          `MetaKocka has no profit centre called "${value}". Add it in MetaKocka first.`,
        );
      }

      await saveProfitCenter(principal, value, verdict);
      await appendEvent(principal, {
        entityType: "profit_center",
        event: "profit_center.added",
        detail: { value, verdict },
      });

      return {
        ok: true,
        scope: "register" as const,
        warn: verdict === "unknown",
        message:
          verdict === "unknown"
            ? `Added ${value}. MetaKocka could not confirm it.`
            : `Added ${value}.`,
      };
    } catch (error) {
      // Never a hard block. A centre we could not check is still a centre the
      // merchant can see in MetaKocka, and refusing it would strand them on our
      // inability to ask. It is stored unchecked and the copy says so.
      if (error instanceof MetakockaError) {
        await saveProfitCenter(principal, value, "unknown");
        await appendEvent(principal, {
          entityType: "profit_center",
          event: "profit_center.added",
          detail: { value, verdict: "unknown" },
        });
        return {
          ok: true,
          scope: "register" as const,
          warn: true,
          message: `Added ${value}. MetaKocka did not answer, so it is unchecked.`,
        };
      }
      throw error;
    }
  }

  if (intent === "remove-profit-center") {
    const value = String(formData.get("value") ?? "").trim();
    const defaults = await getSupplyDefaults(principal);

    if (defaults.defaultProfitCenter === value) {
      return fail("register", "This is the default. Change the default first.");
    }

    const inUse = await sourcesUsingProfitCenter(principal, value);
    if (inUse.length > 0) {
      return fail(
        "register",
        `${inUse.join(", ")} still ${inUse.length === 1 ? "uses" : "use"} it. Change ${inUse.length === 1 ? "that location" : "those locations"} first.`,
      );
    }

    await removeProfitCenter(principal, value);
    await appendEvent(principal, {
      entityType: "profit_center",
      event: "profit_center.removed",
      detail: { value },
    });

    return {
      ok: true,
      scope: "register" as const,
      message: `Removed ${value}.`,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Connect or edit one location                                           */
  /* ---------------------------------------------------------------------- */

  if (intent !== "save-location") {
    return fail("page", "That action is not available. Reload the page.");
  }

  /*
   * The rules live in `web/lib/locations.server`, because guided setup connects
   * locations too and one writer per Shopify location is not an invariant worth
   * having two implementations of.
   */
  const locationId = String(formData.get("location") ?? "").trim();
  const outcome = await saveLocationMapping(principal, {
    shopifyLocationId: locationId,
    warehouseMark: String(formData.get("warehouse") ?? ""),
    locationName: String(formData.get("locationName") ?? ""),
    direction: String(formData.get("direction") ?? INHERIT),
    profitCenter: String(formData.get("profitCenter") ?? INHERIT),
    viaConnect: String(formData.get("via") ?? "") === "connect",
  });

  return {
    ok: outcome.ok,
    scope: "location" as const,
    locationId,
    message: outcome.message,
  };
};

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** One word for where stock is counted. Used in labels and inherited hints. */
const DIRECTION_LABEL: Record<string, string> = {
  mk_to_shopify: "MetaKocka",
  shopify_to_mk: "Shopify",
  none: "Do not synchronize stock",
};

/** Per choice, so the modal needs no explanatory paragraphs. */
const DIRECTION_HELP: Record<string, string> = {
  mk_to_shopify: "Shopify on hand is set from MetaKocka.",
  shopify_to_mk: "The MetaKocka warehouse is set from Shopify.",
  none: "Neither side is changed.",
};

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

/** The part of the Polaris modal element this page drives from code. */
// Optional: a custom element is a plain HTMLElement until the browser upgrades
// it, and a ref is set before that happens. These calls all follow a user
// action so the element has long since upgraded, but the types should not
// promise something that is only true later.
type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

const HELP_MODAL_ID = "about-locations";
const EDITOR_MODAL_ID = "location-editor";
const CONNECT_MODAL_ID = "warehouse-connect";
const REGISTER_MODAL_ID = "profit-center-register";
const SAVE_BAR_ID = "sync-defaults-save-bar";

interface LocationDraft {
  mark: string;
  direction: string;
  profitCenter: string;
}

export default function Locations() {
  const {
    connected,
    defaults: savedDefaults,
    profitCenters,
    checking,
    locations,
    unconnected,
    syncing,
    recent,
    syncedAt,
  } = useLoaderData<typeof loader>();

  /**
   * Four fetchers, because four different things on this page can be in flight
   * and each has its own place to report.
   *
   * Nothing here is a submittable `<Form>`. The page this replaced held several,
   * and a form that can be submitted by anything other than a person pressing a
   * button eventually is: the event log showed saves nobody asked for.
   */
  const defaultsFetcher = useFetcher<typeof action>();
  const locationFetcher = useFetcher<typeof action>();
  const registerFetcher = useFetcher<typeof action>();
  const pageFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const savingDefaults = defaultsFetcher.state !== "idle";
  const savingLocation = locationFetcher.state !== "idle";
  const savingRegister = registerFetcher.state !== "idle";
  const busy = pageFetcher.state !== "idle";

  const [draft, setDraft] = useState(savedDefaults);
  const [editing, setEditing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [location, setLocation] = useState<LocationDraft>({
    mark: "",
    direction: INHERIT,
    profitCenter: INHERIT,
  });
  const [connectTo, setConnectTo] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [showUnconnected, setShowUnconnected] = useState(false);
  const [newCenter, setNewCenter] = useState("");

  const editor = useRef<Overlay | null>(null);
  const connector = useRef<Overlay | null>(null);

  /*
   * Which dialog is up, so a save closes that one and only that one.
   *
   * Both dialogs share `locationFetcher`, and a success used to hide both. The
   * element for a dialog that was never opened is still mounted and still takes
   * the call, and this component set is known to push a modal back -- dimmed,
   * with nothing on top -- when it believes another one is open above it. Not
   * worth finding out the hard way a second time (see components/dropdown.tsx).
   */
  const openDialog = useRef<"editor" | "connect" | null>(null);

  /* --- Sync defaults, on the contextual save bar (section 2.6) ----------- */

  /**
   * The stored values are the truth, but only once they have actually changed.
   * The loader hands back a fresh object on every run, and it runs after every
   * save and on every revalidation; keyed on identity this threw away whatever
   * the merchant had chosen each time.
   */
  const savedKey = JSON.stringify(savedDefaults);
  const appliedKey = useRef(savedKey);
  useEffect(() => {
    if (appliedKey.current === savedKey) return;
    appliedKey.current = savedKey;
    setDraft(savedDefaults);
  }, [savedKey, savedDefaults]);

  /**
   * The bar is driven from the page's own idea of dirty.
   *
   * `data-save-bar` listens for change events on a form's fields, and every
   * value here lives in a hidden input written by React, which fires none. The
   * bar simply never appeared.
   */
  const dirty = JSON.stringify(draft) !== savedKey;

  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show(SAVE_BAR_ID);
    else void shopify.saveBar.hide(SAVE_BAR_ID);
  }, [dirty]);

  // Leaving with the bar up would leave it up over the next page.
  useEffect(
    () => () => {
      if (typeof shopify !== "undefined")
        void shopify.saveBar.hide(SAVE_BAR_ID);
    },
    [],
  );

  /* --- Dialogs close on success, and only on success --------------------- */

  useEffect(() => {
    const result = locationFetcher.data;
    if (!result?.ok) return;
    if (openDialog.current === "editor") editor.current?.hideOverlay?.();
    if (openDialog.current === "connect") connector.current?.hideOverlay?.();
    openDialog.current = null;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [locationFetcher.data]);

  useEffect(() => {
    const result = registerFetcher.data;
    if (!result?.ok) return;
    setNewCenter("");
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [registerFetcher.data]);

  useEffect(() => {
    const result = defaultsFetcher.data ?? pageFetcher.data;
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [defaultsFetcher.data, pageFetcher.data]);

  /**
   * The register check runs in a background job, so the page has to look again
   * to see it. It checks for a minute and stops: a check that has not landed by
   * then has failed, the nightly run will try again, and a page that polls for
   * as long as it stays open is worse than a slightly old list.
   */
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!checking) return;

    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      if (checks > 12) {
        clearInterval(timer);
        return;
      }
      const current = revalidatorRef.current;
      if (current.state === "idle") current.revalidate();
    }, 5000);

    return () => clearInterval(timer);
  }, [checking]);

  /* --- Derived ----------------------------------------------------------- */

  const edited = locations.find((row) => row.id === editing) ?? null;
  const connectingWarehouse =
    unconnected.find((w) => w.mark === connecting) ?? null;

  const defaultDirectionLabel =
    DIRECTION_LABEL[savedDefaults.direction] ?? DIRECTION_LABEL.none!;
  const defaultCenterLabel = savedDefaults.profitCenter || "None";

  const centerOptions: DropdownOption[] = [
    { value: "", label: "None" },
    ...profitCenters
      // INHERIT can never be a real name, so it can never be ambiguous.
      .filter((entry) => entry.value !== INHERIT)
      .map((entry) => ({
        value: entry.value,
        label: entry.isValid
          ? entry.value
          : `${entry.value} (no longer in MetaKocka)`,
      })),
  ];

  const warehouseOptions: DropdownOption[] = [
    { value: "", label: "Not connected" },
    ...unconnected.map((w) => ({ value: w.mark, label: w.name })),
    // The one this location already holds is not in `unconnected`, so it has to
    // be added back or the dialog would open showing nothing chosen.
    ...(edited?.warehouseMark
      ? [
          {
            value: edited.warehouseMark,
            label: edited.warehouseName ?? edited.warehouseMark,
          },
        ]
      : []),
  ];

  /*
   * Only locations that have no warehouse yet.
   *
   * This is the mirror of the warehouse list in the editor, which offers the
   * unconnected warehouses and nothing else. Offering a taken location here
   * made the dialog look like it could do something it should not: choosing one
   * would quietly move its warehouse off it, and a merchant connecting a new
   * warehouse is not asking to disconnect an old one. Changing which warehouse
   * a location uses is what Edit on that location is for.
   *
   * Parenthetical notes rather than the em-dash chain this replaced, and both
   * are worth keeping: an inactive location cannot be sold from, and one owned
   * by a fulfilment service is one section 7 forbids this app to write.
   */
  const freeLocations = locations.filter((row) => row.warehouseMark === "");

  const locationOptions: DropdownOption[] = [
    { value: "", label: "Choose a location" },
    ...freeLocations.map((row) => {
      const notes = [
        row.isActive ? null : "inactive",
        row.fulfillmentServiceName
          ? `fulfilled by ${row.fulfillmentServiceName}`
          : null,
      ].filter(Boolean);

      return {
        value: row.id,
        label:
          notes.length > 0 ? `${row.name} (${notes.join(", ")})` : row.name,
      };
    }),
  ];

  const invalidDefault =
    savedDefaults.profitCenter !== "" &&
    profitCenters.some(
      (entry) => entry.value === savedDefaults.profitCenter && !entry.isValid,
    );

  const uncheckedCount = profitCenters.filter((entry) => !entry.checked).length;
  const rejected = profitCenters.filter((entry) => !entry.isValid);

  const openEditor = (row: (typeof locations)[number]) => {
    openDialog.current = "editor";
    setEditing(row.id);
    setAdvanced(!row.directionInherited || !row.profitCenterInherited);
    setLocation({
      mark: row.warehouseMark,
      direction: row.directionInherited ? INHERIT : row.direction,
      profitCenter: row.profitCenterInherited ? INHERIT : row.profitCenter,
    });
  };

  const saveLocation = () => {
    if (!edited) return;
    locationFetcher.submit(
      {
        intent: "save-location",
        location: edited.id,
        locationName: edited.name,
        warehouse: location.mark,
        direction: location.direction,
        profitCenter: location.profitCenter,
      },
      { method: "post" },
    );
  };

  const saveConnection = () => {
    if (!connectingWarehouse) return;
    const target = locations.find((row) => row.id === connectTo);
    locationFetcher.submit(
      {
        intent: "save-location",
        via: "connect",
        location: connectTo,
        locationName: target?.name ?? "",
        warehouse: connectingWarehouse.mark,
        direction: INHERIT,
        profitCenter: INHERIT,
      },
      { method: "post" },
    );
  };

  const locationResult =
    locationFetcher.data?.scope === "location" ? locationFetcher.data : null;
  const registerResult =
    registerFetcher.data?.scope === "register" ? registerFetcher.data : null;
  const defaultsResult =
    defaultsFetcher.data?.scope === "defaults" ? defaultsFetcher.data : null;
  const pageResult =
    pageFetcher.data?.scope === "page" ? pageFetcher.data : null;

  return (
    <s-page heading="Locations">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

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

      {/*
       * The contextual save bar (section 2.6), driven explicitly. The primary
       * button is Save and the plain one is Discard: that is how App Bridge
       * tells them apart.
       */}
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={() =>
            defaultsFetcher.submit(
              { intent: "save-defaults", ...draft },
              { method: "post" },
            )
          }
          {...(savingDefaults ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={() => setDraft(savedDefaults)}>Discard</button>
      </ui-save-bar>

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

      {/* --- Per-location editor ------------------------------------------ */}

      <s-modal
        id={EDITOR_MODAL_ID}
        heading={edited ? edited.name : "Location"}
        ref={(element: Overlay | null) => {
          editor.current = element;
        }}
      >
        <s-stack direction="block" gap="large">
          {locationResult &&
          !locationResult.ok &&
          locationResult.locationId === edited?.id ? (
            <s-banner tone="critical" heading="That did not save">
              <s-paragraph>{locationResult.message}</s-paragraph>
            </s-banner>
          ) : null}

          <Dropdown
            name="warehouse"
            label="MetaKocka warehouse"
            details="Stock and orders for this location use this warehouse."
            value={location.mark}
            options={warehouseOptions}
            onChange={(next) =>
              setLocation((current) => ({ ...current, mark: next }))
            }
          />

          {/*
           * Progressive disclosure rather than a Collapsible: `s-*` has no
           * collapsible element, and a button that shows a box is the same
           * thing without inventing layout of our own (section 2.6).
           */}
          <s-stack direction="block" gap="base">
            <s-button
              variant="tertiary"
              icon={advanced ? "chevron-up" : "chevron-down"}
              onClick={() => setAdvanced((open) => !open)}
              accessibilityLabel={
                advanced ? "Hide advanced settings" : "Show advanced settings"
              }
            >
              Advanced
            </s-button>

            {advanced ? (
              <s-stack direction="block" gap="large">
                <s-choice-list
                  name="direction"
                  label="Stock source of truth"
                  values={[location.direction]}
                  /*
                   * Read the event before the updater, not inside it.
                   *
                   * A function passed to a setter is called by React during the
                   * next render, and `currentTarget` is null by then. Closing
                   * over the event here crashed the page on the first choice
                   * made: "Cannot read properties of null (reading 'values')".
                   */
                  onChange={(e) => {
                    const next = e.currentTarget.values[0] ?? INHERIT;
                    setLocation((current) => ({ ...current, direction: next }));
                  }}
                >
                  <s-choice value={INHERIT}>
                    Use the default
                    <s-text slot="details">{`Currently ${defaultDirectionLabel}.`}</s-text>
                  </s-choice>
                  <s-choice value="mk_to_shopify">
                    MetaKocka
                    <s-text slot="details">
                      {DIRECTION_HELP.mk_to_shopify}
                    </s-text>
                  </s-choice>
                  <s-choice value="shopify_to_mk">
                    Shopify
                    <s-text slot="details">
                      {DIRECTION_HELP.shopify_to_mk}
                    </s-text>
                  </s-choice>
                  <s-choice value="none">
                    Do not sync stock
                    <s-text slot="details">{DIRECTION_HELP.none}</s-text>
                  </s-choice>
                </s-choice-list>

                <Dropdown
                  name="profitCenter"
                  label="Profit centre"
                  details="Sent to MetaKocka on this location's orders."
                  value={location.profitCenter}
                  options={[
                    {
                      value: INHERIT,
                      label: `Using default: ${defaultCenterLabel}`,
                    },
                    ...centerOptions,
                  ]}
                  onChange={(next) =>
                    setLocation((current) => ({
                      ...current,
                      profitCenter: next,
                    }))
                  }
                />
              </s-stack>
            ) : null}
          </s-stack>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={saveLocation}
          {...(savingLocation ? { loading: true, disabled: true } : {})}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          command="--hide"
          commandFor={EDITOR_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* --- Connect an unconnected warehouse ----------------------------- */}

      <s-modal
        id={CONNECT_MODAL_ID}
        heading={
          connectingWarehouse
            ? `Connect ${connectingWarehouse.name}`
            : "Connect"
        }
        ref={(element: Overlay | null) => {
          connector.current = element;
        }}
      >
        <s-stack direction="block" gap="large">
          {locationResult &&
          !locationResult.ok &&
          locationResult.locationId === connectTo ? (
            <s-banner tone="critical" heading="That did not save">
              <s-paragraph>{locationResult.message}</s-paragraph>
            </s-banner>
          ) : null}

          {freeLocations.length === 0 ? (
            <s-paragraph>
              Every location already has a warehouse. Edit a location above to
              change which warehouse it uses.
            </s-paragraph>
          ) : (
            <Dropdown
              name="location"
              label="Shopify location"
              details="The warehouse takes the sync defaults once connected."
              value={connectTo}
              options={locationOptions}
              onChange={setConnectTo}
            />
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={saveConnection}
          {...(savingLocation || !connectTo
            ? { loading: savingLocation, disabled: true }
            : {})}
        >
          Connect
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          command="--hide"
          commandFor={CONNECT_MODAL_ID}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* --- Profit centre register --------------------------------------- */}

      <s-modal id={REGISTER_MODAL_ID} heading="Profit centres">
        <s-stack direction="block" gap="large">
          {registerResult && !registerResult.ok ? (
            <s-banner tone="critical" heading="That did not work">
              <s-paragraph>{registerResult.message}</s-paragraph>
            </s-banner>
          ) : null}

          {registerResult?.warn ? (
            <s-banner tone="warning" heading="Not checked">
              <s-paragraph>{registerResult.message}</s-paragraph>
            </s-banner>
          ) : null}

          {/*
           * A field, a button and the list. Why a register exists at all, and
           * why it has to be typed, are in the page's Help: this dialog is
           * opened to do something, and three paragraphs of preamble are read
           * once and in the way every time after that.
           *
           * The link stays. It sits beside Add because that is the moment it
           * is needed: the name has to match MetaKocka exactly, so looking it
           * up is part of the task rather than background reading.
           */}
          <s-stack direction="block" gap="base">
            <s-text-field
              name="value"
              label="Name in MetaKocka"
              details="Type it exactly as MetaKocka has it."
              value={newCenter}
              onChange={(e) => setNewCenter(e.currentTarget.value)}
            />
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="secondary"
                onClick={() =>
                  registerFetcher.submit(
                    { intent: "add-profit-center", value: newCenter },
                    { method: "post" },
                  )
                }
                {...(savingRegister || newCenter.trim() === ""
                  ? { loading: savingRegister, disabled: true }
                  : {})}
              >
                Add
              </s-button>
              <s-link href={METAKOCKA_REGISTERS_URL} target="_blank">
                Open registers in MetaKocka
              </s-link>
            </s-stack>
          </s-stack>

          {profitCenters.length === 0 ? (
            <s-text color="subdued">Nothing in the register yet.</s-text>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Name</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
                <s-table-header listSlot="labeled">Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {profitCenters.map((entry) => (
                  <s-table-row key={entry.value}>
                    <s-table-cell>
                      <s-text type="strong">{entry.value}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {!entry.isValid ? (
                        <s-badge tone="critical">Not in MetaKocka</s-badge>
                      ) : entry.checked ? (
                        <s-badge tone="success">Checked</s-badge>
                      ) : (
                        <s-badge tone="neutral">Not checked</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Remove ${entry.value}`}
                        onClick={() =>
                          registerFetcher.submit(
                            {
                              intent: "remove-profit-center",
                              value: entry.value,
                            },
                            { method: "post" },
                          )
                        }
                        {...(savingRegister ? { disabled: true } : {})}
                      >
                        Remove
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={REGISTER_MODAL_ID}
        >
          Done
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          onClick={() =>
            registerFetcher.submit(
              { intent: "refresh-profit-centers" },
              { method: "post" },
            )
          }
          {...(savingRegister || !connected ? { disabled: true } : {})}
        >
          Check again
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
        ) : defaultsResult && !defaultsResult.ok ? (
          <s-banner tone="warning" heading="Saved, with an exception">
            <s-paragraph>{defaultsResult.message}</s-paragraph>
          </s-banner>
        ) : rejected.length > 0 ? (
          <s-banner tone="warning" heading="Profit centres to check">
            <s-paragraph>
              {`MetaKocka no longer has ${rejected.map((entry) => entry.value).join(", ")}. Orders using ${rejected.length === 1 ? "it" : "them"} will be refused.`}
            </s-paragraph>
            <s-button
              slot="primary-action"
              command="--show"
              commandFor={REGISTER_MODAL_ID}
            >
              Open the register
            </s-button>
          </s-banner>
        ) : uncheckedCount > 0 && !checking ? (
          <s-banner tone="warning" heading="Register not checked">
            <s-paragraph>
              {`${uncheckedCount} ${uncheckedCount === 1 ? "profit centre has" : "profit centres have"} not been checked against MetaKocka.`}
            </s-paragraph>
            <s-button
              slot="primary-action"
              onClick={() =>
                registerFetcher.submit(
                  { intent: "refresh-profit-centers" },
                  { method: "post" },
                )
              }
              {...(!connected ? { disabled: true } : {})}
            >
              Retry
            </s-button>
          </s-banner>
        ) : null}

        {/* --- Stock sync -------------------------------------------------- */}

        <s-section heading="Stock sync">
          {/*
           * The count sits in the section's own header slot, beside the
           * heading, rather than as the first thing in the body. It describes
           * the card; reading it as a line of content meant reading past it to
           * reach the two buttons that actually do something.
           *
           * Neutral, not green. It is the normal state, and colour marks
           * exceptions (docs/ui-conventions.md). Not being connected is an
           * exception, so that one keeps its tone.
           */}
          <s-badge slot="secondary-actions" tone="neutral">
            {syncing === 1
              ? "1 location syncing"
              : `${syncing} locations syncing`}
          </s-badge>
          {connected ? null : (
            <s-badge slot="secondary-actions" tone="caution">
              MetaKocka not connected
            </s-badge>
          )}

          <s-stack direction="block" gap="base">
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

        <s-section heading="Stock">
          <s-stack direction="block" gap="large">
            <s-text color="subdued">
              Every location follows these unless you change it.
            </s-text>

            <s-stack direction="block" gap="small-400">
              <Dropdown
                name="direction"
                label="Where do you normally count stock?"
                details="The side you count is copied to the other."
                value={draft.direction}
                options={[
                  { value: "mk_to_shopify", label: "MetaKocka (recommended)" },
                  { value: "shopify_to_mk", label: "Shopify" },
                  { value: "none", label: "Do not synchronize stock" },
                ]}
                onChange={(next) =>
                  setDraft((current) => ({ ...current, direction: next }))
                }
              />
              <s-text color="subdued">
                {describeDirection(toDirection(draft.direction)).flow
                  ? `Stock flows ${describeDirection(toDirection(draft.direction)).flow}.`
                  : "No stock is copied in either direction."}
              </s-text>
            </s-stack>

            <s-stack direction="block" gap="base">
              {checking ? (
                <s-stack direction="block" gap="small-400">
                  <s-text type="strong">Default profit centre</s-text>
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    <s-spinner accessibilityLabel="Checking" />
                    <s-text color="subdued">Checking with MetaKocka</s-text>
                  </s-stack>
                </s-stack>
              ) : (
                <Dropdown
                  name="profitCenter"
                  label="Default profit centre"
                  details="Sent to MetaKocka on every order."
                  value={draft.profitCenter}
                  options={centerOptions}
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, profitCenter: next }))
                  }
                  {...(invalidDefault
                    ? {
                        error:
                          "MetaKocka no longer has this centre. Choose another one.",
                      }
                    : {})}
                />
              )}

              <s-button
                variant="tertiary"
                command="--show"
                commandFor={REGISTER_MODAL_ID}
              >
                Manage profit centres
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

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

                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        accessibilityLabel={`Edit ${row.name}`}
                        command="--show"
                        commandFor={EDITOR_MODAL_ID}
                        onClick={() => openEditor(row)}
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
                variant="tertiary"
                icon={showUnconnected ? "chevron-up" : "chevron-down"}
                onClick={() => setShowUnconnected((open) => !open)}
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
                            variant="tertiary"
                            accessibilityLabel={`Connect ${warehouse.name}`}
                            command="--show"
                            commandFor={CONNECT_MODAL_ID}
                            onClick={() => {
                              openDialog.current = "connect";
                              setConnecting(warehouse.mark);
                              setConnectTo("");
                            }}
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
