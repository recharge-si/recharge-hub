import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  listPricelists,
  listTaxRates,
  recordObservation,
  rememberPricelistCode,
} from "~/adapters/db/repositories/pricelist.server";
import {
  getProductSyncSetting,
  saveProductSyncSetting,
} from "~/adapters/db/repositories/product-sync-setting.server";
import { metakockaNamesFor } from "~/adapters/db/repositories/sku.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  describeForMerchant,
  MetakockaError,
} from "~/adapters/metakocka/errors";
import { observeCatalogue } from "~/adapters/metakocka/pricelists";
import { taxFactorFromPercent } from "~/adapters/metakocka/products";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import {
  countVariants,
  listMetafieldDefinitions,
  listVariantDetails,
  type VariantCount,
} from "~/adapters/shopify/products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  buildPreview,
  fieldRegistry,
  hasBlockingError,
  lintTemplate,
  NAME_PATTERNS,
  nameFor,
  parseTemplate,
  settingsFromTemplate,
  type Diagnostic,
  type MetafieldDefinition,
  type VariantFacts,
} from "~/domain/products/template";
import {
  DEFAULT_UNIT,
  METAKOCKA_UNITS,
  isKnownUnit,
} from "~/domain/products/units";
import { Dropdown } from "~/web/components/dropdown";
import { NamePatternField } from "~/web/components/name-pattern-field";
import { NamePreviewTable } from "~/web/components/name-preview-table";
import { OverwriteWarning } from "~/web/components/overwrite-warning";
import { formatDateTime } from "~/web/lib/datetime";
import { METAKOCKA_PRICELISTS_URL } from "~/web/lib/metakocka-links";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Settings for writing product names and prices into MetaKocka (CLAUDE.md §8.9).
 *
 * Every switch here defaults to off. This is the only place in the app that
 * writes into the ERP's catalogue, so nothing happens until the merchant says
 * it should.
 *
 * Laid out like the locations and payment type pages: explanation behind Help,
 * short sections, an explicit save bar, and the long preview behind a button
 * rather than filling the page. The preview, the lint and the save check all
 * run through `domain/products/template`, the same entry point the sync job
 * uses; `tests/unit/template-agreement.test.ts` holds them to each other.
 */
const HELP_MODAL_ID = "about-product-names";
const PREVIEW_MODAL_ID = "name-preview";
const SAVE_BAR_ID = "product-sync-save-bar";

/**
 * How many of the merchant's products the check covers.
 *
 * Enough to see a pattern behave on more than one shape of product, few enough
 * that a settings page reads one small page of the catalogue rather than all of
 * it (§2.5). What blocks saving is exactly this set, and the screen says so:
 * twelve rows out of a large catalogue is a sample, not an answer.
 */
const PREVIEW_SIZE = 12;

const previewOptions = { first: PREVIEW_SIZE, maxPages: 1, metafields: true };

/** A pricelist register changes a few times a year, so a day old is current. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Long enough that reloading the page a few times sends one job, not five. */
const REFRESH_THROTTLE_SECONDS = 30 * 60;

function knownMetafieldPaths(definitions: MetafieldDefinition[]): Set<string> {
  return new Set(
    definitions.map(
      (definition) => `${definition.namespace}.${definition.key}`,
    ),
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [
    settings,
    samples,
    definitions,
    catalogue,
    pricelists,
    taxRates,
    credential,
  ] = await Promise.all([
    getProductSyncSetting(principal),
    listVariantDetails(admin, previewOptions),
    listMetafieldDefinitions(admin),
    // How big the catalogue actually is, so the preview can say what fraction
    // of it the merchant is looking at. Twelve rows out of twelve thousand
    // products is a sample; twelve out of twelve is the whole catalogue, and
    // the screen must not let those read the same.
    countVariants(admin),
    listPricelists(principal),
    listTaxRates(principal),
    getCredential(principal),
  ]);

  // What MetaKocka calls these products now, read from our own registry. No
  // page load waits on a MetaKocka call (§2.5), so a SKU we have never matched
  // comes back absent and one matched before the name was recorded comes back
  // null — the preview reports those as "created" and "not read yet" rather
  // than inventing a rename.
  const currentNames = await metakockaNamesFor(
    principal,
    samples.map((sample) => sample.sku),
  );

  /*
   * Keep the pricelist register current without ever waiting on it. A nightly
   * job already refreshes it; this covers the shop that connected an hour ago.
   * Enqueued, never awaited (§2.5).
   */
  const observedAt = pricelists
    .map((entry) => entry.observedAt)
    .filter((at): at is Date => at !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const stale =
    observedAt === undefined ||
    Date.now() - observedAt.getTime() > STALE_AFTER_MS;

  let refreshing = false;
  if (credential && stale) {
    await enqueueThrottled(
      QUEUES.reloadPricelists,
      { shopDomain: session.shop },
      `pricelists:${session.shop}`,
      REFRESH_THROTTLE_SECONDS,
    );
    refreshing = true;
  }

  return {
    settings: {
      ...settings,
      lastRunAt: settings.lastRunAt?.toISOString() ?? null,
    },
    samples,
    definitions,
    catalogue,
    currentNames: [...currentNames.entries()],
    pricelists: pricelists.map((entry) => ({
      code: entry.code,
      title: entry.title,
      includesTax: entry.includesTax,
    })),
    pricelistsReadAt: observedAt?.toISOString() ?? null,
    taxRates,
    connected: Boolean(credential),
    refreshing,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const value = (name: string) => String(formData.get(name) ?? "").trim();
  const checked = (name: string) => formData.get(name) === "on";

  /*
   * Reading the pricelists on request, for the merchant who has just made one
   * and does not want to wait for tonight. Its own intent rather than part of
   * the save: it writes nothing to the settings and nothing to MetaKocka.
   */
  if (value("intent") === "load-pricelists") {
    const credential = await getCredential(principal);
    if (!credential) {
      return {
        ok: false,
        field: null,
        message:
          "Connect MetaKocka first. The pricelists come from your company's own products.",
      };
    }

    try {
      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        { timeoutMs: 60_000 },
      );
      const counts = await recordObservation(
        principal,
        await observeCatalogue(client),
      );

      if (counts.pricelists === 0) {
        return {
          ok: false,
          field: null,
          message:
            "No product in MetaKocka has a price on it, so there is no pricelist to find. Type the code by hand, exactly as it appears in MetaKocka.",
        };
      }

      return {
        ok: true,
        field: null,
        message: `Found ${counts.pricelists} ${counts.pricelists === 1 ? "pricelist" : "pricelists"} in MetaKocka.`,
      };
    } catch (error) {
      if (error instanceof MetakockaError) {
        return { ok: false, field: null, message: describeForMerchant(error) };
      }
      throw error;
    }
  }

  const nameTemplate = value("nameTemplate");
  const rawPolicy = value("namePolicy");
  const namePolicy =
    rawPolicy === "when_empty"
      ? "when_empty"
      : rawPolicy === "never"
        ? "never"
        : "always";

  const sendPricing = checked("sendPricing");
  const pricelistCode = value("pricelistCode");
  const taxPercent = value("taxPercent");

  // MetaKocka accepts any unit string and validates none of them (section 3),
  // so a value outside its register becomes a silently wrong product.
  const unit = value("unit") || DEFAULT_UNIT;
  if (!isKnownUnit(unit)) {
    return {
      ok: false,
      field: "unit",
      message: `"${unit}" is not a unit in MetaKocka's register. Choose one from the list.`,
    };
  }

  if (nameTemplate === "") {
    return {
      ok: false,
      field: "nameTemplate",
      message:
        "The name cannot be empty. Add at least one field, for example the product title.",
    };
  }

  const parsed = parseTemplate(nameTemplate);
  const parseError = parsed.errors[0];
  if (parseError) {
    return { ok: false, field: "nameTemplate", message: parseError.message };
  }

  /*
   * The same check the screen shows, run again where it cannot be skipped.
   * One small GraphQL call on an explicit save, not on every render. Two names
   * that collide would become one product in the ERP, so it is worth the call.
   */
  const [samples, definitions] = await Promise.all([
    listVariantDetails(admin, previewOptions),
    listMetafieldDefinitions(admin),
  ]);

  const blocking = lintTemplate({
    nodes: parsed.nodes,
    variants: samples,
    knownMetafields: knownMetafieldPaths(definitions),
  }).find((diagnostic) => diagnostic.severity === "error");

  if (blocking) {
    return { ok: false, field: "nameTemplate", message: blocking.message };
  }

  /*
   * §3: a pricelist cannot be created through the API and cannot be guessed.
   * Every sales order carries it as `sales_pricelist_code`, so it is required
   * whether or not product prices are synced.
   */
  if (pricelistCode === "") {
    return {
      ok: false,
      field: "pricelistCode",
      message:
        "Choose the pricelist this shop's prices belong to. It must already exist in MetaKocka; the API cannot create one, and there is no safe value to assume.",
    };
  }

  /*
   * §3, verified: MetaKocka refuses a document line with no tax attribute and
   * will not infer one. Zero is not a safe stand-in — it files the right gross
   * against a net that matches no pricelist and understates the VAT.
   */
  if (taxPercent === "") {
    return {
      ok: false,
      field: "taxPercent",
      message:
        "Enter the VAT rate this shop charges, for example 22. MetaKocka refuses an order line with no tax rate, and sending zero would understate the VAT rather than leave it unanswered.",
    };
  }

  if (taxFactorFromPercent(taxPercent) === null) {
    return {
      ok: false,
      field: "taxPercent",
      message:
        "The VAT rate must be a percentage between 0 and 100, for example 22.",
    };
  }

  await saveProductSyncSetting(principal, {
    enabled: checked("enabled"),
    nameTemplate,
    namePolicy,
    createMissing: checked("createMissing"),
    sendPricing,
    updatePricing: sendPricing && checked("updatePricing"),
    pricelistCode,
    pricelistIncludesTax: value("pricelistBasis") !== "net",
    taxPercent,
    unit: unit,
  });

  // A code typed by hand is kept in the register so the picker offers it back
  // rather than presenting an empty field on the next visit.
  await rememberPricelistCode(principal, pricelistCode);

  await appendEvent(principal, {
    entityType: "product_sync",
    event: "product_sync.settings_saved",
    detail: { enabled: checked("enabled"), namePolicy },
  });

  return { ok: true, field: null, message: "Saved product sync settings." };
};

interface FormState {
  enabled: boolean;
  nameTemplate: string;
  namePolicy: string;
  createMissing: boolean;
  sendPricing: boolean;
  updatePricing: boolean;
  pricelistCode: string;
  pricelistBasis: string;
  taxPercent: string;
  unit: string;
}

function toState(settings: {
  enabled: boolean;
  nameTemplate: string;
  namePolicy: string;
  createMissing: boolean;
  sendPricing: boolean;
  updatePricing: boolean;
  pricelistCode: string | null;
  pricelistIncludesTax: boolean;
  taxPercent: string | null;
  unit: string;
}): FormState {
  return {
    enabled: settings.enabled,
    nameTemplate: settings.nameTemplate,
    namePolicy: settings.namePolicy,
    createMissing: settings.createMissing,
    sendPricing: settings.sendPricing,
    updatePricing: settings.updatePricing,
    pricelistCode: settings.pricelistCode ?? "",
    pricelistBasis: settings.pricelistIncludesTax ? "gross" : "net",
    taxPercent: settings.taxPercent ?? "",
    unit: settings.unit,
  };
}

/** Errors first: they are what stops the merchant, and they say why. */
function bySeverity(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
}

/** Fixed locale so the server and the browser render the same string. */
const NUMBER = new Intl.NumberFormat("en-GB");

/**
 * What the check covers, said plainly.
 *
 * The one thing this must never do is let a sample read as the catalogue. A
 * merchant with twelve thousand variants seeing twelve rows has been shown
 * roughly a thousandth of what a sync would touch, and every count on this
 * screen is out of those twelve.
 */
function previewScope(shown: number, catalogue: VariantCount | null): string {
  if (shown === 0) return "";
  if (!catalogue) {
    return `Checked against ${shown} of your products. Anything not shown has not been checked.`;
  }
  if (catalogue.exact && catalogue.count <= shown) {
    return `Checked against all ${NUMBER.format(catalogue.count)} of your products.`;
  }

  const total = catalogue.exact
    ? NUMBER.format(catalogue.count)
    : `more than ${NUMBER.format(catalogue.count)}`;
  return `Checked against ${shown} of your ${total} products. Anything not shown has not been checked.`;
}

/** Counts by outcome, which is what the merchant is deciding on. */
function previewSummary(totals: {
  changed: number;
  unchanged: number;
  created: number;
  unknown: number;
}): string {
  const parts = [
    totals.changed > 0 ? `${totals.changed} renamed` : null,
    totals.created > 0 ? `${totals.created} to create` : null,
    totals.unknown > 0 ? `${totals.unknown} not read yet` : null,
    totals.unchanged > 0 ? `${totals.unchanged} unchanged` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? `${parts.join(", ")}.` : "";
}

export default function ProductSyncSettings() {
  const {
    settings,
    samples,
    definitions,
    catalogue,
    currentNames,
    pricelists,
    pricelistsReadAt,
    taxRates,
    connected,
    refreshing,
  } = useLoaderData<typeof loader>();

  /*
   * Both writes go through fetchers, so this page contains no submittable form.
   *
   * The save bar is driven from the page's own idea of dirty rather than from
   * App Bridge watching a form: `data-save-bar` listens for change events, and
   * every Dropdown here writes its value onto a hidden input from React, which
   * fires nothing a listener can hear. Changing the name policy alone left the
   * bar hidden and the setting unsaveable. This is what the payment types page
   * does, and for the same reason.
   */
  const saver = useFetcher<typeof action>();
  const reloader = useFetcher<typeof action>();
  const saving = saver.state !== "idle";
  const result = saver.data ?? reloader.data;

  const [state, setState] = useState<FormState>(() => toState(settings));
  // §2.8: no error before the merchant has had a chance to answer.
  const [touched, setTouched] = useState(false);
  /**
   * Whether the pricelist is being typed rather than chosen. The merchant is
   * never hard-blocked on a list we could not load, so a shop with no
   * pricelists to offer starts here.
   */
  const [pricelistByHand, setPricelistByHand] = useState(
    () => pricelists.length === 0,
  );
  /**
   * Advanced starts closed, and opens itself when something inside it is the
   * reason a save was refused. A merchant should never be told a field is
   * wrong and then have to guess which card it is folded into.
   */
  const [advanced, setAdvanced] = useState(false);

  const set = (patch: Partial<FormState>) =>
    setState((current) => ({ ...current, ...patch }));

  /*
   * What is stored is the truth, but only when it has actually changed. The
   * loader returns a fresh object on every run — including after a rejected
   * save and while a pricelist refresh is in flight — and keying on identity
   * would throw away whatever the merchant had just typed.
   */
  const savedKey = JSON.stringify(toState(settings));
  const appliedKey = useRef(savedKey);

  useEffect(() => {
    if (appliedKey.current === savedKey) return;
    appliedKey.current = savedKey;
    setState(toState(settings));
    setTouched(false);
  }, [savedKey, settings]);

  const dirty = JSON.stringify(state) !== savedKey;

  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show(SAVE_BAR_ID);
    else void shopify.saveBar.hide(SAVE_BAR_ID);
  }, [dirty]);

  // Leaving with the bar still up would leave it up over the next page.
  useEffect(
    () => () => {
      if (typeof shopify !== "undefined")
        void shopify.saveBar.hide(SAVE_BAR_ID);
    },
    [],
  );

  useEffect(() => {
    if (saver.data && !saver.data.ok && saver.data.field === "unit") {
      setAdvanced(true);
    }
  }, [saver.data]);

  useEffect(() => {
    if (!saver.data?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(saver.data.message);
  }, [saver.data]);

  const registry = useMemo(() => fieldRegistry(definitions), [definitions]);
  const knownMetafields = useMemo(
    () => knownMetafieldPaths(definitions),
    [definitions],
  );
  const names = useMemo(
    () => new Map<string, string | null>(currentNames),
    [currentNames],
  );

  const naming = useMemo(
    () => settingsFromTemplate(state.nameTemplate),
    [state.nameTemplate],
  );

  const parsed = useMemo(
    () => parseTemplate(state.nameTemplate),
    [state.nameTemplate],
  );

  /*
   * Computed as the merchant types, from their own products, through the same
   * function the sync job calls. Nothing here reaches MetaKocka.
   */
  const preview = useMemo(
    () =>
      buildPreview({
        settings: naming,
        variants: samples as VariantFacts[],
        currentNames: names,
        knownMetafields,
      }),
    [naming, samples, names, knownMetafields],
  );

  const diagnostics = useMemo(
    () => bySeverity(preview.diagnostics),
    [preview.diagnostics],
  );
  const parseError = parsed.errors[0];
  const blocked = Boolean(parseError) || hasBlockingError(preview.diagnostics);

  const fieldError =
    touched && parseError
      ? parseError.message
      : touched && blocked
        ? (diagnostics.find((d) => d.severity === "error")?.message ??
          undefined)
        : result && !result.ok && result.field === "nameTemplate"
          ? result.message
          : undefined;

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const patternSample = samples[0] ?? null;
  const loadingPricelists = refreshing || reloader.state !== "idle";
  const reloadFailed = reloader.data && !reloader.data.ok;

  const chosen = pricelists.find((entry) => entry.code === state.pricelistCode);

  /*
   * The name MetaKocka gave it, not the code it is filed under.
   *
   * Leading with the code read badly on real data — "2 — Price List 2" starts
   * with a number that is not part of the name and then repeats it — and a
   * merchant choosing a pricelist is choosing it by what they called it. The
   * code is what actually goes to MetaKocka, so it is stated once under the
   * field rather than folded into every row.
   *
   * It comes back into the label only where the name cannot tell two apart: a
   * pricelist with no name at all, or two sharing one.
   */
  const titleCounts = new Map<string, number>();
  for (const entry of pricelists) {
    if (!entry.title) continue;
    titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1);
  }

  const pricelistOptions = pricelists.map((entry) => ({
    value: entry.code,
    label: !entry.title
      ? `Code ${entry.code}`
      : (titleCounts.get(entry.title) ?? 0) > 1
        ? `${entry.title} (code ${entry.code})`
        : entry.title,
  }));

  /**
   * What the price would be written into, in the merchant's own words.
   *
   * "The pricelist above" is not an answer to "which one will this overwrite".
   * MetaKocka's own title for it is, so the destructive switch names it and so
   * does the warning beside it. Falls back to the bare code when the pricelist
   * has no title, and says nothing has been chosen when nothing has.
   */
  /**
   * Net or gross, where the catalogue has already answered it.
   *
   * A pricelist's type is fixed when it is created and MetaKocka refuses the
   * wrong field outright (§3), so this is not a preference — it is a fact about
   * the pricelist. When the merchant's own priced products carry it, asking
   * them to confirm it is asking a question we can already answer, so the
   * choice does not sit in the main card -- the fact rides on the pricelist's
   * own line instead. It is still settable, under Advanced, because a
   * pricelist nobody has priced anything on cannot be read this way.
   */
  const observedBasis =
    chosen && chosen.includesTax !== null
      ? chosen.includesTax
        ? "gross"
        : "net"
      : null;
  /** One line under the field carrying both facts about it. */
  const pricelistDetails = !chosen
    ? "Found on your own priced products."
    : observedBasis
      ? `Sent to MetaKocka as code ${chosen.code}. Prices on it ${observedBasis === "gross" ? "include" : "exclude"} tax.`
      : `Sent to MetaKocka as code ${chosen.code}.`;

  const otherRates = taxRates.filter(
    (rate) => rate !== state.taxPercent.trim().replace(",", "."),
  );

  const pricelistName = chosen?.title?.trim()
    ? `“${chosen.title.trim()}”`
    : state.pricelistCode
      ? `pricelist ${state.pricelistCode}`
      : null;

  const save = () =>
    saver.submit(
      {
        intent: "save",
        enabled: state.enabled ? "on" : "",
        nameTemplate: state.nameTemplate,
        namePolicy: state.namePolicy,
        createMissing: state.createMissing ? "on" : "",
        sendPricing: state.sendPricing ? "on" : "",
        updatePricing: state.updatePricing ? "on" : "",
        pricelistCode: state.pricelistCode,
        pricelistBasis: state.pricelistBasis,
        taxPercent: state.taxPercent,
        unit: state.unit,
      },
      { method: "post" },
    );

  const discard = () => {
    setState(toState(settings));
    setTouched(false);
  };

  const reloadPricelists = () =>
    reloader.submit({ intent: "load-pricelists" }, { method: "post" });

  return (
    <s-page heading="Product sync settings">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

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

      <s-modal id={HELP_MODAL_ID} heading="About product names">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shopify owns the customer-facing title. MetaKocka owns everything
            else about a product, so product sync writes the name — and creates
            products, and writes prices, if you turn those on.
          </s-paragraph>
          <s-paragraph>
            The name is built from pieces of your Shopify product. Type the name
            as it should read, and type {"{"} where you want Shopify to fill
            something in. A piece with no value on a product disappears from
            that product&rsquo;s name, along with the space or dash beside it.
          </s-paragraph>
          <s-paragraph>
            Nothing is written to MetaKocka until you press Sync products on the
            Products page.
          </s-paragraph>
          <s-paragraph>
            Pricelists live in MetaKocka under Sales &rsaquo; Pricelists. The
            code this app asks for is the one shown there as &ldquo;Price list
            ID&rdquo;. Every sales order carries that code and the VAT rate,
            whether or not product prices are synced, which is why both are
            needed even with sync off.
          </s-paragraph>
          <s-link href={METAKOCKA_PRICELISTS_URL} target="_blank">
            Open pricelists in MetaKocka
          </s-link>
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

      <s-modal id={PREVIEW_MODAL_ID} heading="What changes in MetaKocka">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            {previewScope(preview.totals.rows, catalogue)}
          </s-text>
          <NamePreviewTable
            rows={preview.rows}
            empty="No Shopify variant has a SKU yet, so there is nothing to name."
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={PREVIEW_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-stack direction="block" gap="large">
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {/*
         * The master switch, and the only thing in its own card.
         *
         * It was called "Send product names to MetaKocka", which understated
         * it: the job it gates writes names, creates products and writes
         * prices, so a merchant reading the old label could turn on price
         * overwriting believing they had only agreed to names.
         */}
        <s-section heading="Product sync">
          <s-checkbox
            name="enabled"
            value="on"
            label="Sync products to MetaKocka"
            details="Names, new products and prices. Nothing is written to MetaKocka while this is off."
            checked={state.enabled}
            onChange={(e) => set({ enabled: e.currentTarget.checked })}
          />
        </s-section>

        {state.enabled ? (
          <>
            <s-section heading="Product names">
              <s-stack direction="block" gap="base">
                <Dropdown
                  name="namePolicy"
                  label="When MetaKocka already has a name"
                  value={state.namePolicy}
                  onChange={(next) => set({ namePolicy: next })}
                  options={[
                    {
                      value: "always",
                      label: "Replace it with the Shopify name",
                    },
                    {
                      value: "when_empty",
                      label: "Only fill it in when it is empty",
                    },
                    { value: "never", label: "Leave it alone" },
                  ]}
                />
                {/* Part 1 of the overwrite pattern: always present, names what is
                overwritten and how often. */}
                <s-text color="subdued">
                  {state.namePolicy === "always"
                    ? "Every sync replaces the name in MetaKocka. A name edited there is overwritten on the next run."
                    : state.namePolicy === "when_empty"
                      ? "A MetaKocka product that already has a name keeps it."
                      : "Existing MetaKocka products are never renamed."}
                </s-text>
                {/* Part 2: only in the unsaved state, only newly on. */}
                <OverwriteWarning
                  saved={settings.namePolicy === "always"}
                  current={state.namePolicy === "always"}
                  heading="Shopify becomes the name master"
                >
                  Save this and the next sync replaces the name of every matched
                  MetaKocka product, including names edited in MetaKocka.
                </OverwriteWarning>

                <NamePatternField
                  name="nameTemplate"
                  label="Product name in MetaKocka"
                  value={state.nameTemplate}
                  onChange={(next) => {
                    setTouched(true);
                    set({ nameTemplate: next });
                  }}
                  registry={registry}
                  sample={patternSample ?? null}
                  {...(fieldError ? { error: fieldError } : {})}
                />

                {/*
                 * One banner, never two next to each other (§2.8). Errors sort
                 * first and set the tone; warnings ride along in the same block.
                 */}
                {touched && diagnostics.length > 0 ? (
                  <s-banner
                    tone={blocked ? "critical" : "warning"}
                    heading={
                      blocked
                        ? "This name cannot be saved yet"
                        : "Worth checking before you save"
                    }
                  >
                    <s-unordered-list>
                      {diagnostics.map((diagnostic) => (
                        <s-list-item
                          key={`${diagnostic.code}-${diagnostic.message}`}
                        >
                          {diagnostic.message}
                          {diagnostic.sampleIds.length > 0
                            ? ` For example: ${diagnostic.sampleIds.join(", ")}.`
                            : ""}
                        </s-list-item>
                      ))}
                    </s-unordered-list>
                  </s-banner>
                ) : null}

                <s-stack direction="block" gap="small-300">
                  <s-text type="strong">Or start from a ready pattern</s-text>
                  <s-grid
                    gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))"
                    gap="small-300"
                  >
                    {NAME_PATTERNS.map((option) => {
                      const inUse = option.pattern === state.nameTemplate;
                      const produced = patternSample
                        ? nameFor(
                            settingsFromTemplate(option.pattern),
                            patternSample as VariantFacts,
                          ).name
                        : null;

                      return (
                        <s-clickable
                          key={option.id}
                          accessibilityLabel={
                            produced
                              ? `${option.label}. Would produce ${produced}.`
                              : option.label
                          }
                          onClick={() => {
                            setTouched(true);
                            set({ nameTemplate: option.pattern });
                          }}
                        >
                          <s-box
                            background="subdued"
                            borderRadius="base"
                            padding="small-200"
                          >
                            <s-stack direction="block" gap="small-500">
                              <s-text type="strong">{option.label}</s-text>
                              {/*
                               * The name this pattern gives one of the merchant's
                               * own products. A shop with an empty catalogue gets
                               * the pattern's name and no invented example.
                               */}
                              {produced ? (
                                <s-text color="subdued">{produced}</s-text>
                              ) : null}
                              {inUse ? (
                                <s-text color="subdued">In use</s-text>
                              ) : null}
                            </s-stack>
                          </s-box>
                        </s-clickable>
                      );
                    })}
                  </s-grid>
                </s-stack>

                {/*
                 * The detail is behind a button, like the locations page puts a
                 * location behind one. On the page it is a single line of counts
                 * by outcome, which is the thing being decided.
                 */}
                <s-stack direction="block" gap="small-300">
                  <s-text color="subdued">
                    {previewSummary(preview.totals)}
                  </s-text>
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={PREVIEW_MODAL_ID}
                  >
                    See what changes
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Creating products MetaKocka does not have">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="createMissing"
                  value="on"
                  label="Create missing products in MetaKocka"
                  details="Uses the SKU as the code, the name above, and the barcode."
                  checked={state.createMissing}
                  onChange={(e) =>
                    set({ createMissing: e.currentTarget.checked })
                  }
                />

                <s-checkbox
                  name="sendPricing"
                  value="on"
                  label="Give a new product its Shopify price"
                  details="Applies only as a product is created."
                  checked={state.sendPricing}
                  onChange={(e) =>
                    set({ sendPricing: e.currentTarget.checked })
                  }
                />
              </s-stack>
            </s-section>
          </>
        ) : null}

        {/*
         * Everything about money in one place.
         *
         * The switch that replaces prices used to have a section to itself,
         * one card away from the pricelist it writes into and the rate it
         * converts with — so "the pricelist below" meant a pricelist in a
         * different card. Reading it now means reading one section.
         *
         * What Part B was actually fixing still holds: it is not filed under a
         * heading about products MetaKocka is missing, which is the opposite of
         * its blast radius.
         *
         * The pricelist and the rate stay visible whether or not names are
         * being synced, because every sales order carries them. The switch does
         * not: with name sync off the job returns before it could write a price.
         */}
        <s-section heading="Prices and tax in MetaKocka">
          <s-stack direction="block" gap="base">
            {/*
             * First in the section and set apart, because it is the only
             * setting here that destroys something. It was last, under the VAT
             * rate, which is the least-read spot on the card.
             *
             * Set apart with a border rather than a colour: colour marks
             * exceptions, and this is a choice rather than a problem
             * (docs/ui-conventions.md). The payment types page frames its
             * fallback the same way.
             *
             * Hidden entirely while names are not being sent, because the sync
             * job returns before it reaches a price.
             */}
            {state.enabled ? (
              <s-box
                padding="base"
                background="subdued"
                borderRadius="base"
                borderWidth="base"
                borderStyle="solid"
                borderColor="subdued"
              >
                <s-stack direction="block" gap="small-300">
                  <s-checkbox
                    name="updatePricing"
                    value="on"
                    label="Keep prices up to date from Shopify"
                    checked={state.updatePricing}
                    disabled={!state.sendPricing}
                    onChange={(e) =>
                      set({ updatePricing: e.currentTarget.checked })
                    }
                  />
                  {/*
                   * Part 1 of the overwrite pattern, as a line beneath the
                   * control rather than as the checkbox's own `details`.
                   *
                   * Two reasons, and they agree. The name policy states its
                   * part 1 exactly this way, and the doc asks for one pattern
                   * applied identically — using `details` here made them two.
                   * And `details` hangs a second line off the label, which
                   * leaves the tick sitting against the top of a two-line
                   * block instead of level with a one-line one.
                   */}
                  <s-text color="subdued">
                    {pricelistName
                      ? `Every sync overwrites the price in ${pricelistName} with the Shopify price.`
                      : "Every sync overwrites the price in the pricelist below with the Shopify price. Choose one first."}
                  </s-text>
                  {state.sendPricing ? null : (
                    <s-text color="subdued">
                      Turn on &ldquo;Give a new product its Shopify price&rdquo;
                      to use this.
                    </s-text>
                  )}
                  {/*
                   * Gated on sending prices as well, because that is what the
                   * action stores: with it off nothing is overwritten.
                   */}
                  <OverwriteWarning
                    saved={settings.updatePricing}
                    current={state.updatePricing && state.sendPricing}
                    heading="Shopify becomes the price master"
                  >
                    {pricelistName
                      ? `Save this and the next sync overwrites the price of every matched product in ${pricelistName}, including prices edited in MetaKocka.`
                      : "Save this and the next sync overwrites the price of every matched product, including prices edited in MetaKocka."}
                  </OverwriteWarning>
                </s-stack>
              </s-box>
            ) : null}

            {reloadFailed ? (
              <s-banner tone="warning" heading="Could not read your pricelists">
                <s-paragraph>{reloader.data?.message}</s-paragraph>
                <s-button
                  slot="primary-action"
                  type="button"
                  onClick={reloadPricelists}
                >
                  Try again
                </s-button>
              </s-banner>
            ) : null}

            {pricelistByHand || pricelistOptions.length === 0 ? (
              <s-stack direction="block" gap="small-400">
                <s-text-field
                  name="pricelistCode"
                  label="MetaKocka pricelist code"
                  details="In MetaKocka this is the pricelist's own “Price list ID”."
                  value={state.pricelistCode}
                  onChange={(e) =>
                    set({ pricelistCode: e.currentTarget.value })
                  }
                  {...(errorFor("pricelistCode")
                    ? { error: errorFor("pricelistCode") }
                    : {})}
                />
                <s-link href={METAKOCKA_PRICELISTS_URL} target="_blank">
                  Open pricelists in MetaKocka
                </s-link>
              </s-stack>
            ) : (
              <Dropdown
                name="pricelistCode"
                label="MetaKocka pricelist"
                details={pricelistDetails}
                value={state.pricelistCode}
                onChange={(next) => set({ pricelistCode: next })}
                options={pricelistOptions}
                {...(errorFor("pricelistCode")
                  ? { error: errorFor("pricelistCode") }
                  : {})}
              />
            )}

            {state.pricelistCode !== "" && !chosen ? (
              <s-text color="subdued">
                No priced product uses this code, so it could not be confirmed.
                That is expected for a pricelist you have just made.
              </s-text>
            ) : null}

            <s-stack direction="inline" gap="base" alignItems="center">
              {pricelistOptions.length > 0 ? (
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => setPricelistByHand((now) => !now)}
                >
                  {pricelistByHand
                    ? "Choose from your pricelists"
                    : "Type a code instead"}
                </s-button>
              ) : null}
              <s-button
                type="button"
                variant="secondary"
                onClick={reloadPricelists}
                {...(loadingPricelists || !connected ? { disabled: true } : {})}
              >
                Refresh now
              </s-button>
              {/* Beside the button rather than under it, so the button and
                  what it last did read as one thing. The payment types page
                  states the same fact the same way. */}
              {loadingPricelists ? (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-spinner size="base" accessibilityLabel="Refreshing" />
                  <s-text color="subdued">Reading in the background.</s-text>
                </s-stack>
              ) : (
                <s-text color="subdued">
                  {pricelistsReadAt
                    ? `Last read ${formatDateTime(pricelistsReadAt)}.`
                    : "Not read yet."}
                </s-text>
              )}
            </s-stack>

            <s-text-field
              name="taxPercent"
              label="Default VAT rate (%)"
              details="Used on order lines when Shopify gives no rate."
              value={state.taxPercent}
              onChange={(e) => set({ taxPercent: e.currentTarget.value })}
              {...(errorFor("taxPercent")
                ? { error: errorFor("taxPercent") }
                : {})}
            />
            {/*
             * Only rates the field does not already hold. A shop with one VAT
             * rate, already typed in, was being offered it back as the only
             * suggestion — a whole row saying nothing.
             */}
            {otherRates.length > 0 ? (
              <s-stack direction="inline" gap="small-400" alignItems="center">
                <s-text color="subdued">Rates you already use:</s-text>
                {otherRates.map((rate) => (
                  <s-clickable-chip
                    key={rate}
                    onClick={() => set({ taxPercent: rate })}
                  >
                    {`${rate}%`}
                  </s-clickable-chip>
                ))}
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        {/*
         * The two settings that are right almost always and wrong occasionally.
         *
         * Neither belongs in the flow. The pricelist's tax basis is a fact the
         * catalogue usually tells us, and the unit is MetaKocka's default for
         * nearly every Slovenian company — but a pricelist with nothing priced
         * on it cannot be read, and a company selling by weight needs the unit,
         * so neither can simply go.
         *
         * Collapsed, with the answer summarised on the closed card, so the
         * common case costs one line and the uncommon one costs one click. The
         * Show action sits in the section's own header slot, like the count on
         * the locations page.
         */}
        {state.enabled ? (
          <s-section heading="Advanced">
            <s-button
              slot="secondary-actions"
              type="button"
              variant="tertiary"
              onClick={() => setAdvanced((now) => !now)}
            >
              {advanced ? "Hide" : "Show"}
            </s-button>

            {advanced ? (
              <s-stack direction="block" gap="base">
                <Dropdown
                  name="pricelistBasis"
                  label="Prices on that pricelist are"
                  details={
                    observedBasis
                      ? `Your own priced products say this pricelist is ${observedBasis}. Change it only if they are wrong.`
                      : "No priced product could tell us. If this is wrong, the first sync says so and corrects itself."
                  }
                  value={state.pricelistBasis}
                  onChange={(next) => set({ pricelistBasis: next })}
                  options={[
                    { value: "gross", label: "Including tax (gross)" },
                    { value: "net", label: "Excluding tax (net)" },
                  ]}
                />

                <Dropdown
                  name="unit"
                  label="Unit of measure for new products"
                  details="MetaKocka only accepts a unit from its own register."
                  value={state.unit}
                  onChange={(next) => set({ unit: next })}
                  options={METAKOCKA_UNITS.map((unit) => ({
                    value: unit,
                    label: unit,
                  }))}
                  {...(errorFor("unit") ? { error: errorFor("unit") } : {})}
                />
              </s-stack>
            ) : (
              <s-text color="subdued">
                {`Prices ${state.pricelistBasis === "gross" ? "include" : "exclude"} tax, new products are sold in ${state.unit}.`}
              </s-text>
            )}
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
