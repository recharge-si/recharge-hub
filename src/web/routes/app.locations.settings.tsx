import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
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
import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { validateProfitCenter } from "~/adapters/metakocka/profit-centers";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { describeDirection } from "~/domain/readiness";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import { LearnMore } from "~/web/components/learn-more";
import { INHERIT, toDirection } from "~/web/lib/locations";
import {
  loadLocationRows,
  saveLocationMapping,
} from "~/web/lib/locations.server";
import { METAKOCKA_REGISTERS_URL } from "~/web/lib/metakocka-links";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * What every location follows unless it says otherwise.
 *
 * Split out of the Locations page, which had become two screens in one: what
 * stock is doing right now, and the two settings that decide it. The same split
 * Products has — the page you land on is what is happening, and Settings in its
 * header is what it was told to do — and the same reason: a merchant checking
 * whether stock is moving should not have to read past a form to find out.
 *
 * The profit-centre register lives here too. It is the list the default is
 * chosen from, and a register is a setting rather than a status.
 */
const REGISTER_MODAL_ID = "profit-centre-register";
const SAVE_BAR_ID = "location-defaults-save-bar";

/** Long enough that reloading the page a few times sends one job, not five. */
const REFRESH_THROTTLE_SECONDS = 5 * 60;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [connected, defaults, profitCenters, rows] = await Promise.all([
    isConnected(principal),
    getSupplyDefaults(principal),
    listProfitCenters(principal),
    // Without the activity log: which warehouse a location uses is what is
    // edited here, and how its last run went is what the page you land on
    // reports.
    loadLocationRows(admin, principal),
  ]);

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
    locations: rows.locations,
    unconnected: rows.unconnected,
  };
};

/**
 * Which part of the screen a result belongs to.
 *
 * A save that fails inside a dialog has to say so inside that dialog: the page
 * banner behind it is not something the merchant can read or reach while it is
 * open (section 2.8).
 */
type ResultScope = "defaults" | "register" | "location";

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
  /* The profit centre register                                             */
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

  if (intent === "save-location") {
    /*
     * The rules live in `web/lib/locations.server`, because guided setup
     * connects locations too and one writer per Shopify location is not an
     * invariant worth having two implementations of.
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
  }

  return fail("defaults", "That action is not available. Reload the page.");
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

/** Per choice, so the dialog needs no explanatory paragraphs. */
const DIRECTION_HELP: Record<string, string> = {
  mk_to_shopify: "Shopify on hand is set from MetaKocka.",
  shopify_to_mk: "The MetaKocka warehouse is set from Shopify.",
  none: "Neither side is changed.",
};

/** The part of the Polaris modal element this page drives from code. */
// Optional: a custom element is a plain HTMLElement until the browser upgrades
// it, and a ref is set before that happens.
type Overlay = { showOverlay?: () => void; hideOverlay?: () => void };

interface LocationDraft {
  mark: string;
  direction: string;
  profitCenter: string;
}

const EDITOR_MODAL_ID = "location-editor";
const CONNECT_MODAL_ID = "warehouse-connect";

export default function LocationDefaults() {
  const {
    connected,
    defaults: savedDefaults,
    profitCenters,
    checking,
    locations,
    unconnected,
  } = useLoaderData<typeof loader>();

  /*
   * Two fetchers, because the card and the dialog each have their own place to
   * report. Nothing here is a submittable `<Form>`: a form that can be
   * submitted by anything other than a person pressing a button eventually is.
   */
  const defaultsFetcher = useFetcher<typeof action>();
  const registerFetcher = useFetcher<typeof action>();
  const locationFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();

  const savingDefaults = defaultsFetcher.state !== "idle";
  const savingRegister = registerFetcher.state !== "idle";
  const savingLocation = locationFetcher.state !== "idle";

  const [draft, setDraft] = useState(savedDefaults);
  const [newCenter, setNewCenter] = useState("");

  const [editing, setEditing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [location, setLocation] = useState<LocationDraft>({
    mark: "",
    direction: INHERIT,
    profitCenter: INHERIT,
  });
  const [connectTo, setConnectTo] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const editor = useRef<Overlay | null>(null);
  const connector = useRef<Overlay | null>(null);

  /*
   * Which dialog is up, so a save closes that one and only that one.
   *
   * Both dialogs share `locationFetcher`, and a success used to hide both. The
   * element for a dialog that was never opened is still mounted and still takes
   * the call, and this component set is known to push a modal back — dimmed,
   * with nothing on top — when it believes another one is open above it.
   */
  const openDialog = useRef<"editor" | "connect" | null>(null);

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
    const result = defaultsFetcher.data;
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [defaultsFetcher.data]);

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

  /*
   * Arriving from the Locations page, which sends `?location=` or `?connect=`.
   *
   * The dialog is opened here rather than by the link, because a link cannot
   * press a button on the page it lands on. The retry is the awkward part: a
   * Polaris modal is a custom element, and `showOverlay` only exists on it once
   * the browser has upgraded it — which has not necessarily happened by the
   * first effect after mount. It gives up after a second rather than looping.
   *
   * The parameter is dropped once it has been used, so reloading the page or
   * closing the dialog does not open it again.
   */
  const requestedLocation = params.get("location");
  const requestedConnect = params.get("connect");

  useEffect(() => {
    if (!requestedLocation && !requestedConnect) return;

    const row = requestedLocation
      ? locations.find((entry) => entry.id === requestedLocation)
      : null;
    const warehouse = requestedConnect
      ? unconnected.find((entry) => entry.mark === requestedConnect)
      : null;

    if (!row && !warehouse) return;

    if (row) {
      openDialog.current = "editor";
      setEditing(row.id);
      setAdvanced(!row.directionInherited || !row.profitCenterInherited);
      setLocation({
        mark: row.warehouseMark,
        direction: row.directionInherited ? INHERIT : row.direction,
        profitCenter: row.profitCenterInherited ? INHERIT : row.profitCenter,
      });
    } else if (warehouse) {
      openDialog.current = "connect";
      setConnecting(warehouse.mark);
      setConnectTo("");
    }

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const overlay = row ? editor.current : connector.current;
      if (overlay?.showOverlay) {
        overlay.showOverlay();
        clearInterval(timer);
      } else if (attempts > 10) {
        clearInterval(timer);
      }
    }, 100);

    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("location");
        next.delete("connect");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );

    return () => clearInterval(timer);
    // Once, for the parameters this page was opened with.
  }, [requestedLocation, requestedConnect, locations, unconnected, setParams]);

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

  const invalidDefault =
    savedDefaults.profitCenter !== "" &&
    profitCenters.some(
      (entry) => entry.value === savedDefaults.profitCenter && !entry.isValid,
    );

  const uncheckedCount = profitCenters.filter((entry) => !entry.checked).length;
  const rejected = profitCenters.filter((entry) => !entry.isValid);

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
   * Parenthetical notes rather than an em-dash chain, and both are worth
   * keeping: an inactive location cannot be sold from, and one owned by a
   * fulfilment service is one section 7 forbids this app to write.
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
        label: notes.length > 0 ? `${row.name} (${notes.join(", ")})` : row.name,
      };
    }),
  ];

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

  const save = () =>
    defaultsFetcher.submit(
      {
        intent: "save-defaults",
        direction: draft.direction,
        profitCenter: draft.profitCenter,
      },
      { method: "post" },
    );

  return (
    <s-page heading="Location settings">
      <s-link slot="breadcrumb-actions" href="/app/locations">
        Locations
      </s-link>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(savingDefaults ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={() => setDraft(savedDefaults)}>Discard</button>
      </ui-save-bar>

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
              type="button"
              variant="secondary"
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

      {/* --- Profit centre register ----------------------------------- */}

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
           * why it has to be typed, are behind the card's own Learn more: this
           * dialog is opened to do something, and three paragraphs of preamble
           * are read once and in the way every time after that.
           *
           * The way to MetaKocka stays beside Add, because that is the moment
           * it is needed: the name has to match exactly, so looking it up is
           * part of the task rather than background reading.
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
                type="button"
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
              <s-button
                type="button"
                variant="secondary"
                icon="external"
                href={METAKOCKA_REGISTERS_URL}
                target="_blank"
              >
                Open registers in MetaKocka
              </s-button>
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
                        type="button"
                        variant="secondary"
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
          type="button"
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={REGISTER_MODAL_ID}
        >
          Done
        </s-button>
        <s-button
          type="button"
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
         * been able to check.
         */}
        {defaultsResult && !defaultsResult.ok ? (
          <s-banner tone="warning" heading="Saved, with an exception">
            <s-paragraph>{defaultsResult.message}</s-paragraph>
          </s-banner>
        ) : rejected.length > 0 ? (
          <s-banner tone="warning" heading="Profit centres to check">
            <s-paragraph>
              {`MetaKocka no longer has ${rejected.map((entry) => entry.value).join(", ")}. Orders using ${rejected.length === 1 ? "it" : "them"} will be refused.`}
            </s-paragraph>
            <s-button
              type="button"
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
              type="button"
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

        {/*
         * The mappings themselves, first, because a merchant arriving from the
         * Locations page came to change one. The page they came from reports
         * how each is going; this one is where each is decided, so the row
         * carries what it is connected to and nothing about its last run.
         */}
        <s-section heading="Locations and warehouses">
          {locations.length === 0 ? (
            <s-paragraph>
              This store has no locations. Add one in Shopify settings first.
            </s-paragraph>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  Shopify location
                </s-table-header>
                <s-table-header listSlot="labeled">
                  MetaKocka warehouse
                </s-table-header>
                <s-table-header listSlot="labeled">Action</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {locations.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-text type="strong">{row.name}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {row.warehouseName ? (
                        <s-stack direction="block" gap="small-500">
                          <s-text>{row.warehouseName}</s-text>
                          {/*
                           * The mark rides along under the name, the way the
                           * payments page keeps the raw gateway handle: it is
                           * what goes on a MetaKocka document.
                           */}
                          <s-text color="subdued">{row.warehouseMark}</s-text>
                        </s-stack>
                      ) : (
                        <s-text color="subdued">None</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        type="button"
                        variant="secondary"
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

        {unconnected.length === 0 ? null : (
          <s-section heading="MetaKocka warehouses not connected">
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                A warehouse with no Shopify location behind it syncs nothing.
              </s-text>
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Warehouse</s-table-header>
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
                          type="button"
                          variant="secondary"
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
            </s-stack>
          </s-section>
        )}

        <s-section heading="Stock">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Every location follows this unless you change it on the location
              itself.
            </s-text>

            <s-stack direction="block" gap="small-400">
              <s-box maxInlineSize="420px">
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
              </s-box>
              <s-text color="subdued">
                {describeDirection(toDirection(draft.direction)).flow
                  ? `Stock flows ${describeDirection(toDirection(draft.direction)).flow}.`
                  : "No stock is copied in either direction."}
              </s-text>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Profit centre">
          <s-stack direction="block" gap="base">
            {checking ? (
              <s-stack direction="block" gap="small-400">
                <s-text type="strong">Default profit centre</s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-spinner accessibilityLabel="Checking" />
                  <s-text color="subdued">Checking with MetaKocka</s-text>
                </s-stack>
              </s-stack>
            ) : (
              <s-box maxInlineSize="420px">
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
              </s-box>
            )}

            <s-stack direction="inline">
              <s-button
                type="button"
                variant="secondary"
                command="--show"
                commandFor={REGISTER_MODAL_ID}
              >
                Manage profit centres
              </s-button>
            </s-stack>

            <LearnMore label="What a profit centre is for">
              <s-paragraph>
                MetaKocka files each document against a profit centre, and it
                refuses a document naming one it does not have. It has no
                endpoint that lists them, so this app keeps a register of the
                ones you have named and checks each against MetaKocka.
              </s-paragraph>
              <s-paragraph>
                The default is sent on every order that has not overridden it.
                Leave it as None to let MetaKocka apply the company setting.
              </s-paragraph>
            </LearnMore>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
