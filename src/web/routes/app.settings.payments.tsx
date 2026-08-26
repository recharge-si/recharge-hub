import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
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
  getFallbackPaymentType,
  listCachedPaymentTypes,
  listPaymentTypeMaps,
  replaceCachedPaymentTypes,
  replacePaymentTypeMaps,
  saveFallbackPaymentType,
} from "~/adapters/db/repositories/payment-type-map.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  describeForMerchant,
  MetakockaError,
} from "~/adapters/metakocka/errors";
import { discoverPaymentTypes } from "~/adapters/metakocka/payment-types";
import {
  COMMON_GATEWAYS,
  listPaymentGateways,
} from "~/adapters/shopify/payment-gateways";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { Dropdown, type DropdownOption } from "~/web/components/dropdown";
import { formatDateTime } from "~/web/lib/datetime";
import { METAKOCKA_REGISTERS_URL } from "~/web/lib/metakocka-links";
import { gatewayLabel } from "~/web/lib/payment-gateways";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Shopify payment gateway to MetaKocka payment type (CLAUDE.md §8.7).
 *
 * One row per gateway, each with a select. This replaced a two-column diagram
 * joined by drawn SVG curves: the curves needed the DOM measured on every render
 * and every resize to know where to begin and end, they had nothing sensible to
 * draw once the columns stacked on a narrow screen, and all that machinery
 * existed to express "this settles into that" — which a row and a select say
 * plainly, and which a screen reader can actually read.
 *
 * Several gateways may point at the same type, so nothing is deduped or
 * disabled. One gateway points at one type, because `payment_type` on a document
 * is a single string.
 *
 * The type list is never filtered. Real registers hold odd entries — a
 * one-letter test row, an old name kept for reconciliation — and hiding them
 * would puzzle whoever put them there.
 */
const HELP_MODAL_ID = "payment-types-help";
const SAVE_BAR_ID = "payment-mapping-save-bar";

/** A payment register changes a few times a year, so a day old is current. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Long enough that reloading the page a few times sends one job, not five. */
const REFRESH_THROTTLE_SECONDS = 5 * 60;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [maps, used, types, connected, fallback] = await Promise.all([
    listPaymentTypeMaps(principal),
    listPaymentGateways(admin),
    listCachedPaymentTypes(principal),
    isConnected(principal),
    getFallbackPaymentType(principal),
  ]);

  // Gateways this shop has used, plus the ones any store can produce, plus
  // anything already mapped so a mapping never silently disappears.
  const gateways = [
    ...new Set([
      ...used,
      ...COMMON_GATEWAYS,
      ...maps.map((row) => row.shopifyGateway),
    ]),
  ].sort((a, b) => gatewayLabel(a).localeCompare(gatewayLabel(b)));

  const loadedAt = types[0]?.syncedAt ?? null;

  /**
   * The list keeps itself current, and opening this page is the one moment
   * where being a day out of date is visible.
   *
   * A nightly job already refreshes it. This covers the two cases the nightly
   * job cannot: a shop that connected MetaKocka an hour ago and has never had
   * one run, and a merchant who added a payment type in MetaKocka this morning
   * and came straight here to map it.
   *
   * Enqueued, never awaited. A MetaKocka call takes tens of seconds and no page
   * load may wait on one (§2.5), so the screen renders from the database and
   * the fresh list arrives underneath it.
   */
  const stale =
    loadedAt === null || Date.now() - loadedAt.getTime() > STALE_AFTER_MS;

  let refreshing = false;
  if (connected && stale) {
    await enqueueThrottled(
      QUEUES.reloadPaymentTypes,
      { shopDomain: session.shop },
      `payment-types:${session.shop}`,
      REFRESH_THROTTLE_SECONDS,
    );
    refreshing = true;
  }

  return {
    gateways,
    paymentTypes: types
      .map((type) => type.value)
      .sort((a, b) => a.localeCompare(b)),
    typesLoadedAt: loadedAt?.toISOString() ?? null,
    connected,
    refreshing,
    fallback: fallback ?? "",
    mapping: Object.fromEntries(
      maps.map((row) => [row.shopifyGateway, row.metakockaPaymentType]),
    ),
  };
};

/** §4: every external boundary is parsed, and a form field is one. */
const mappingSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), z.string()));

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "load-types") {
    const access = await requireCredential(principal);
    if (!access.ok) {
      return {
        ok: false,
        message:
          access.reason === "not_permitted"
            ? access.message
            : "Connect MetaKocka first. The payment types come from your company's register.",
      };
    }
    const credential = access.credential;

    try {
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 20_000 },
      );
      const values = await discoverPaymentTypes(client);

      if (!values) {
        return {
          ok: false,
          message:
            "MetaKocka did not return a readable list of payment types. Add them by hand instead, exactly as they appear in your register.",
        };
      }

      await replaceCachedPaymentTypes(principal, values);
      await appendEvent(principal, {
        entityType: "payment_type",
        event: "payment_types.loaded",
        detail: { count: values.length },
      });

      return {
        ok: true,
        message: `Loaded ${values.length} payment ${values.length === 1 ? "type" : "types"} from MetaKocka.`,
      };
    } catch (error) {
      if (error instanceof MetakockaError) {
        return { ok: false, message: describeForMerchant(error) };
      }
      throw error;
    }
  }

  const fallback = String(formData.get("fallback") ?? "").trim();

  // Required, because it is the answer for every gateway with no row of its own.
  // Saving without it would leave that question unanswered while looking saved.
  if (fallback === "") {
    return {
      ok: false,
      field: "fallback",
      message: "Choose a type. Every unmapped gateway above uses it.",
    };
  }

  // One JSON field rather than two parallel lists read back with getAll. The
  // lists only lined up as long as every row rendered exactly one of each, in
  // the same order, which is a lot to promise for a mapping where putting a
  // value against the wrong gateway is silent and wrong.
  const parsed = mappingSchema.safeParse(formData.get("mapping"));
  if (!parsed.success) {
    return {
      ok: false,
      message: "The mapping could not be read. Reload the page and try again.",
    };
  }

  const entries = Object.entries(parsed.data)
    .map(([gateway, type]) => ({
      shopifyGateway: gateway.trim(),
      metakockaPaymentType: type.trim(),
    }))
    // An empty choice means "not mapped", stored as the absence of a row.
    .filter(
      (row) => row.shopifyGateway !== "" && row.metakockaPaymentType !== "",
    );

  await replacePaymentTypeMaps(principal, entries);
  await saveFallbackPaymentType(principal, fallback);

  await appendEvent(principal, {
    entityType: "payment_type",
    event: "payment_types.saved",
    detail: { count: entries.length, fallback },
  });

  return {
    ok: true,
    message: `Saved ${entries.length} gateway ${entries.length === 1 ? "mapping" : "mappings"}.`,
  };
};

/**
 * A gateway with no type and a gateway missing from the object mean the same
 * thing, so they have to compare the same. Without this, choosing a type and
 * then choosing "Not mapped" again would leave the save bar up over a form that
 * matches the database.
 */
function normalise(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([, type]) => type !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The raw handle, monospaced so it reads as an identifier rather than prose.
 *
 * It stays on screen next to the label because the handle is what Shopify
 * reports and what this app stores: someone reconciling against Shopify's own
 * reporting needs the exact string, and a friendly label alone leaves them
 * guessing which row is which.
 */
function Handle({ value }: { value: string }) {
  return (
    <s-text color="subdued">
      <span style={{ fontFamily: "var(--s-font-family-mono, monospace)" }}>
        {value}
      </span>
    </s-text>
  );
}

export default function PaymentTypes() {
  const {
    gateways,
    paymentTypes,
    typesLoadedAt,
    connected,
    refreshing,
    fallback: savedFallback,
    mapping: savedMapping,
  } = useLoaderData<typeof loader>();
  /**
   * Both writes go through fetchers, so this page contains no submittable form
   * at all.
   *
   * It used to hold two `<Form method="post">` elements, and they submitted
   * themselves: the event log shows a refresh and a full save that nobody
   * asked for, and the save wrote one payment type across every gateway. A
   * form that can be submitted by anything other than a person pressing a
   * button is a form that will be. There is now nothing on the page to submit.
   */
  const saver = useFetcher<typeof action>();
  const refresher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const saving = saver.state !== "idle";

  // Whichever spoke last is what the merchant is waiting to hear about.
  const result = saver.data ?? refresher.data;

  const [mapping, setMapping] = useState<Record<string, string>>(savedMapping);
  const [fallback, setFallback] = useState(savedFallback);

  /**
   * What is stored is the truth — but only when it has actually changed.
   *
   * This compares the stored values themselves, not the object the loader
   * handed over. The loader returns a fresh object every time it runs, and it
   * runs constantly here: after every save, attempted or not, and every five
   * seconds while a payment type refresh is in flight. Keyed on identity, this
   * threw away whatever the merchant had chosen each time — a save rejected for
   * a missing fallback took the rest of the edits down with it, and edits made
   * during a refresh vanished on their own.
   */
  const savedKey = JSON.stringify([normalise(savedMapping), savedFallback]);
  const appliedKey = useRef(savedKey);

  useEffect(() => {
    if (appliedKey.current === savedKey) return;
    appliedKey.current = savedKey;
    setMapping(savedMapping);
    setFallback(savedFallback);
    // savedMapping and savedFallback are what savedKey is made of.
  }, [savedKey, savedMapping, savedFallback]);

  /**
   * The save bar is driven from the page's own idea of dirty, not from App
   * Bridge watching the form.
   *
   * `data-save-bar` works by listening for change events on a form's fields,
   * and every value on this screen lives in a hidden input written by React —
   * which fires nothing a listener can hear. The bar simply never appeared, so
   * there was no way to save. Comparing the state to what the loader returned
   * is the thing that is actually true, and it is what decides here.
   */
  const dirty = JSON.stringify([normalise(mapping), fallback]) !== savedKey;

  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show(SAVE_BAR_ID);
    else void shopify.saveBar.hide(SAVE_BAR_ID);
  }, [dirty]);

  // Leaving the page with the bar still up would leave it up over the next one.
  useEffect(
    () => () => {
      if (typeof shopify !== "undefined")
        void shopify.saveBar.hide(SAVE_BAR_ID);
    },
    [],
  );

  const discard = () => {
    setMapping(savedMapping);
    setFallback(savedFallback);
  };

  const save = () => {
    saver.submit(
      {
        intent: "save",
        fallback,
        mapping: JSON.stringify(normalise(mapping)),
      },
      { method: "post" },
    );
  };

  const refresh = () => {
    refresher.submit({ intent: "load-types" }, { method: "post" });
  };

  /**
   * The refresh the loader asked for runs in a background job, so the page has
   * to look again to see it. It checks for a minute and then stops: a refresh
   * that has not landed by then has failed, the nightly run will try again, and
   * a page that polls forever is worse than a slightly old list.
   */
  // Through a ref, because the revalidator is a fresh object on every one of
  // its own state changes. As a dependency it would tear down and rebuild the
  // interval every five seconds, resetting the attempt count, and the page
  // would poll for as long as it stayed open.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!refreshing) return;

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
  }, [refreshing, typesLoadedAt]);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const unmapped = gateways.filter((gateway) => !mapping[gateway]);
  const fallbackError =
    result && !result.ok && result.field === "fallback"
      ? result.message
      : undefined;

  /**
   * The empty row is a real answer, not a prompt: it means "no type of its own,
   * use the fallback", which is what the Status column then reports.
   */
  const typeOptions: DropdownOption[] = [
    { value: "", label: "Not mapped" },
    ...paymentTypes.map((type) => ({ value: type, label: type })),
  ];

  /**
   * No empty row. The fallback is what every unmapped gateway falls back to, so
   * "none" is the one answer it cannot hold, and the save refuses it.
   */
  const fallbackOptions: DropdownOption[] = paymentTypes.map((type) => ({
    value: type,
    label: type,
  }));

  return (
    <s-page heading="Payment types">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      {/*
       * Page-level explanation behind a header action, the same as the
       * warehouses page: it is read once, and after that it is in the way.
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
       * The contextual save bar (§2.6), driven explicitly. The primary button
       * is Save and the plain one is Discard — that is how App Bridge tells
       * them apart.
       */}
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(saving ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={discard}>Discard</button>
      </ui-save-bar>

      <s-modal id={HELP_MODAL_ID} heading="About payment types">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Payment types live in MetaKocka, under Settings &rsaquo; Registers,
            with &ldquo;Payment type&rdquo; as the selected register. This page
            only matches Shopify&apos;s gateways to them.
          </s-paragraph>
          <s-link href={METAKOCKA_REGISTERS_URL} target="_blank">
            Open registers in MetaKocka
          </s-link>
          <s-paragraph>
            A type added there turns up here on its own. A gateway with no type
            uses the fallback, so the fallback cannot be empty.
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
        {result && !result.ok && !fallbackError ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="MetaKocka payment types">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              These come from your company&apos;s register in MetaKocka. An
              order can only be marked paid with a type that exists there. The
              app reads the register overnight and whenever this page finds the
              list out of date, so it keeps itself current.
            </s-paragraph>

            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="secondary"
                onClick={refresh}
                {...(refresher.state !== "idle" || !connected
                  ? { disabled: true }
                  : {})}
              >
                Refresh now
              </s-button>
              {refreshing ? (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-spinner size="base" accessibilityLabel="Refreshing" />
                  <s-text color="subdued">
                    Reading the register in the background.
                  </s-text>
                </s-stack>
              ) : (
                <s-text color="subdued">
                  {typesLoadedAt
                    ? `Last read ${formatDateTime(typesLoadedAt)}.`
                    : "Not read yet."}
                </s-text>
              )}
            </s-stack>
          </s-stack>
        </s-section>

        {unmapped.length > 0 ? (
          <s-banner
            tone="warning"
            heading={`${unmapped.length} ${unmapped.length === 1 ? "gateway isn't" : "gateways aren't"} mapped`}
          >
            <s-paragraph>
              Orders paid with these will use the fallback type.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Payment mapping">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Each Shopify gateway settles into one MetaKocka payment type.
              Types can be reused.
            </s-paragraph>

            {/*
             * `auto` is the only choice Polaris offers besides `list`, and
             * it is what keeps this readable on a small screen: the table
             * becomes a list of labelled fields rather than columns that have
             * to scroll sideways.
             *
             * It decides for itself by measuring, and it does not always
             * decide the same way at the same width — the same screen has
             * come back as columns on one load and as stacked labels on the
             * next. Both are legible and both submit the same form, so this
             * is left as Polaris intends rather than fought.
             */}
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Gateway</s-table-header>
                <s-table-header listSlot="labeled">
                  MetaKocka payment type
                </s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {gateways.map((gateway) => {
                  const type = mapping[gateway] ?? "";
                  return (
                    <s-table-row key={gateway}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-text type="strong">{gatewayLabel(gateway)}</s-text>
                          <Handle value={gateway} />
                        </s-stack>
                      </s-table-cell>

                      <s-table-cell>
                        <s-box maxInlineSize="260px">
                          <Dropdown
                            name="type"
                            label={`MetaKocka payment type for ${gatewayLabel(gateway)}`}
                            hideLabel
                            placeholder="Not mapped"
                            value={type}
                            options={typeOptions}
                            onChange={(next) =>
                              setMapping((current) => ({
                                ...current,
                                [gateway]: next,
                              }))
                            }
                          />
                        </s-box>
                      </s-table-cell>

                      <s-table-cell>
                        {type ? (
                          <s-badge tone="success">Mapped</s-badge>
                        ) : (
                          <s-text color="subdued">Fallback</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>

            {/*
             * Pinned below the table rather than inside it. It is not a
             * gateway, and giving it a row would invite it to be read, sorted
             * and counted as one.
             */}
            <s-box
              padding="base"
              background="subdued"
              borderRadius="base"
              borderWidth="base"
              borderStyle="solid"
              borderColor="subdued"
            >
              <s-grid
                gridTemplateColumns="1fr 260px"
                gap="base"
                alignItems="end"
              >
                <s-stack direction="block" gap="small-500">
                  <s-text type="strong">Fallback for unmapped</s-text>
                  <s-text color="subdued">
                    Used for any gateway above with no type of its own.
                  </s-text>
                </s-stack>

                <s-box inlineSize="100%">
                  <Dropdown
                    name="fallback"
                    label="Fallback payment type"
                    hideLabel
                    placeholder="Choose a type"
                    value={fallback}
                    options={fallbackOptions}
                    {...(fallbackError ? { error: fallbackError } : {})}
                    onChange={setFallback}
                  />
                </s-box>
              </s-grid>
            </s-box>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
