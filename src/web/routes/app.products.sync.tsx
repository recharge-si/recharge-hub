import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
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
  getPricelistRegister,
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
  MAX_TEMPLATE_LENGTH,
  MAX_TOKENS,
  NAME_PATTERNS,
  nameFor,
  parseTemplate,
  pickerGroups,
  settingsFromTemplate,
  tokensOf,
  type Diagnostic,
  type MetafieldDefinition,
  type VariantFacts,
} from "~/domain/products/template";
import {
  DEFAULT_UNIT,
  METAKOCKA_UNITS,
  isKnownUnit,
} from "~/domain/products/units";
import { Advanced } from "~/web/components/advanced";
import { AdvancedSection } from "~/web/components/advanced-section";
import { Dropdown } from "~/web/components/dropdown";
import { LearnMore } from "~/web/components/learn-more";
import { PatternEditor } from "~/web/components/pattern-editor";
import { PatternFieldsModal } from "~/web/components/pattern-fields-modal";
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
const PATTERNS_MODAL_ID = "ready-patterns";
const FIELDS_MODAL_ID = "fields-you-can-use";
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
    register,
    taxRates,
    connected,
  ] = await Promise.all([
    getProductSyncSetting(principal),
    listVariantDetails(admin, previewOptions),
    listMetafieldDefinitions(admin),
    // How big the catalogue actually is, so the preview can say what fraction
    // of it the merchant is looking at. Twelve rows out of twelve thousand
    // products is a sample; twelve out of twelve is the whole catalogue, and
    // the screen must not let those read the same.
    countVariants(admin),
    getPricelistRegister(principal),
    listTaxRates(principal),
    isConnected(principal),
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
   *
   * Staleness is measured from when the register was last *read*, not from the
   * newest sighting in it. A shop whose pricelists have all been deleted has no
   * sighting at all, and measuring from sightings would have it re-reading on
   * every page load forever.
   */
  const readAt = register.readAt;
  const stale =
    readAt === null || Date.now() - readAt.getTime() > STALE_AFTER_MS;

  let refreshing = false;
  if (connected && stale) {
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
    pricelists: register.entries.map((entry) => ({
      code: entry.code,
      title: entry.title,
      includesTax: entry.includesTax,
      seen: entry.seen,
      lastSeenAt: entry.observedAt?.toISOString() ?? null,
    })),
    pricelistsReadAt: readAt?.toISOString() ?? null,
    taxRates,
    connected,
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
    const access = await requireCredential(principal);
    if (!access.ok) {
      return {
        ok: false,
        field: null,
        message:
          access.reason === "not_permitted"
            ? access.message
            : "Connect MetaKocka first. The pricelists come from your company's own products.",
      };
    }
    const credential = access.credential;

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

  /*
   * The parser's own limits, enforced where they can actually stop something.
   * They existed as constants and nothing checked them: a pasted essay would
   * have gone into the database and been re-parsed on every render.
   */
  if (nameTemplate.length > MAX_TEMPLATE_LENGTH) {
    return {
      ok: false,
      field: "nameTemplate",
      message: `The name is ${nameTemplate.length} characters long and cannot be more than ${MAX_TEMPLATE_LENGTH}. Remove some of it.`,
    };
  }

  const parsed = parseTemplate(nameTemplate);
  const parseError = parsed.errors[0];
  if (parseError) {
    return { ok: false, field: "nameTemplate", message: parseError.message };
  }

  if (tokensOf(parsed.nodes).length > MAX_TOKENS) {
    return {
      ok: false,
      field: "nameTemplate",
      message: `The name uses more than ${MAX_TOKENS} fields. Remove some of them.`,
    };
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

  const productSales = checked("productSales");
  const productPurchasing = checked("productPurchasing");
  const productService = checked("productService");

  if (!productSales && !productPurchasing && !productService) {
    // MetaKocka accepts an article with none of the three set, and it is then
    // an article that cannot go on any document — least of all the sales order
    // this app writes. Refused here, once, rather than on every order later.
    return {
      ok: false,
      field: "productType",
      message:
        "Choose at least one product type. An article marked none of these cannot be put on a MetaKocka document.",
    };
  }

  /*
   * How often the catalogue is re-read, in minutes.
   *
   * Clamped rather than rejected: this is a cadence, not an identifier, and
   * every value between the bounds is a legitimate answer. Under fifteen
   * minutes would outrun the scheduler that reads it, and a week is long enough
   * that the merchant means "off".
   */
  const scheduleMinutes = Math.min(
    10080,
    Math.max(15, Number(value("scheduleIntervalMinutes")) || 720),
  );

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
    productSales,
    productPurchasing,
    productService,
    updateProductType: checked("updateProductType"),
    scheduleEnabled: checked("scheduleEnabled"),
    scheduleIntervalMinutes: scheduleMinutes,
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
  productSales: boolean;
  productPurchasing: boolean;
  productService: boolean;
  updateProductType: boolean;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: string;
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
  productSales: boolean;
  productPurchasing: boolean;
  productService: boolean;
  updateProductType: boolean;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number;
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
    productSales: settings.productSales,
    productPurchasing: settings.productPurchasing,
    productService: settings.productService,
    updateProductType: settings.updateProductType,
    scheduleEnabled: settings.scheduleEnabled,
    scheduleIntervalMinutes: String(settings.scheduleIntervalMinutes),
  };
}

/**
 * The three MetaKocka type boxes as one phrase: "Sales and Purchase".
 *
 * English labels, matching the MetaKocka product screen the merchant is
 * looking at in the other tab, rather than the API's own `purchasing`.
 */
function typeLabels(state: FormState): string[] {
  const labels: string[] = [];
  if (state.productSales) labels.push("Sales");
  if (state.productPurchasing) labels.push("Purchase");
  if (state.productService) labels.push("Service");
  return labels;
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return "nothing";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
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

  /** Overlay methods land on the element only once the browser upgrades it. */
  const patterns = useRef<{ hideOverlay?: () => void } | null>(null);

  const [state, setState] = useState<FormState>(() => toState(settings));
  // §2.8: no error before the merchant has had a chance to answer.
  const [touched, setTouched] = useState(false);
  /**
   * Whether the pricelist is being typed rather than chosen. The merchant is
   * never hard-blocked on a list we could not load, so a shop with no
   * pricelists to offer starts here — including one whose pricelists were all
   * deleted in MetaKocka, which is a register full of rows and nothing to
   * choose from.
   */
  const [pricelistByHand, setPricelistByHand] = useState(() =>
    pricelists.every((entry) => !entry.seen),
  );

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

  /*
   * The field says what is wrong with the characters; the banner says what is
   * wrong with the names. Showing a lint error in both put two red blocks on
   * screen for one problem, and the field's copy — a sentence about every
   * product checked — was never about the field anyway.
   */
  const fieldError =
    touched && parseError
      ? parseError.message
      : !touched && result && !result.ok && result.field === "nameTemplate"
        ? result.message
        : undefined;

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const patternSample = samples[0] ?? null;

  /*
   * What the picker offers and what the name comes to, both resolved against
   * one of the merchant's own variants. The editor itself knows the syntax and
   * nothing about products, so this is where a product answers for itself.
   */
  const pickerRowsFor = useCallback(
    (query: string) =>
      pickerGroups(registry, query, (patternSample as VariantFacts) ?? null),
    [registry, patternSample],
  );

  const resolvedName = patternSample
    ? nameFor(
        settingsFromTemplate(state.nameTemplate),
        patternSample as VariantFacts,
      ).name
    : null;
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
  /**
   * Only what the newest read actually found.
   *
   * The register keeps a code after it stops being seen, on purpose: a
   * configured setting must not look unconfigured (pricelist.server.ts). But
   * keeping it and *offering* it are different things. A merchant who deleted
   * their pricelists in MetaKocka was still shown "Price List 2" in this
   * picker, ready to be chosen and written into on the next sync, because the
   * read that found nothing changed no row. A pricelist we cannot see is one we
   * cannot vouch for, so it is not on the menu — it can still be typed.
   */
  const offered = pricelists.filter((entry) => entry.seen);
  const canChoose = offered.length > 0;

  const titleCounts = new Map<string, number>();
  for (const entry of offered) {
    if (!entry.title) continue;
    titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1);
  }

  const pricelistOptions = offered.map((entry) => ({
    value: entry.code,
    label: !entry.title
      ? `Code ${entry.code}`
      : (titleCounts.get(entry.title) ?? 0) > 1
        ? `${entry.title} (code ${entry.code})`
        : entry.title,
  }));

  /**
   * The configured code was on a priced product once and is not now. That is a
   * different sentence from "we have never seen it": one is a new pricelist we
   * cannot see into, the other is one that has gone away under a setting still
   * pointing at it.
   */
  const chosenVanished = Boolean(
    chosen && !chosen.seen && chosen.lastSeenAt !== null,
  );

  /**
   * A read has run and found nothing to offer. Said once, and not on top of the
   * line about a specific pricelist having gone, which already explains it.
   */
  const registerEmptied =
    pricelistsReadAt !== null && !canChoose && !chosenVanished;

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
        productSales: state.productSales ? "on" : "",
        productPurchasing: state.productPurchasing ? "on" : "",
        productService: state.productService ? "on" : "",
        updateProductType: state.updateProductType ? "on" : "",
        scheduleEnabled: state.scheduleEnabled ? "on" : "",
        scheduleIntervalMinutes: state.scheduleIntervalMinutes,
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

      {/*
       * Four cards, each as wide as the card holding them, for something a
       * merchant picks once. Behind a button they cost a line; each still
       * shows the name it would give one of their own products, which is the
       * only reason to show a pattern at all (docs/ui-conventions.md).
       */}
      <s-modal
        id={PATTERNS_MODAL_ID}
        heading="Ready patterns"
        ref={(element) => {
          patterns.current = (element as { hideOverlay?: () => void }) ?? null;
        }}
      >
        {/*
         * Rows, the same shape as the field list that opens under the name.
         * As filled grey boxes they read as four separate things to consider;
         * as rows they read as a list to pick from, which is what they are.
         * The tick marks the one in use, the way `dropdown.tsx` marks a chosen
         * option — a word saying "In use" was a second idea in the same line.
         */}
        <s-stack direction="block" gap="none">
          {NAME_PATTERNS.map((option, index) => {
            const inUse = option.pattern === state.nameTemplate;
            const produced = patternSample
              ? nameFor(
                  settingsFromTemplate(option.pattern),
                  patternSample as VariantFacts,
                ).name
              : null;

            return (
              <s-stack key={option.id} direction="block" gap="none">
                {index === 0 ? null : <s-divider />}
                <s-clickable
                  inlineSize="100%"
                  borderRadius="base"
                  paddingInline="small-200"
                  paddingBlock="small-300"
                  accessibilityLabel={
                    produced
                      ? `${option.label}. Would produce ${produced}.`
                      : option.label
                  }
                  onClick={() => {
                    setTouched(true);
                    set({ nameTemplate: option.pattern });
                    patterns.current?.hideOverlay?.();
                  }}
                >
                  <s-grid
                    gridTemplateColumns="1fr auto"
                    gap="small-200"
                    alignItems="center"
                  >
                    <s-stack direction="block" gap="small-500">
                      <s-text type="strong">{option.label}</s-text>
                      {/*
                       * The name this pattern gives one of the merchant's own
                       * products. A shop with an empty catalogue gets the
                       * pattern's name and no invented example.
                       */}
                      {produced ? (
                        <s-text color="subdued">{produced}</s-text>
                      ) : null}
                    </s-stack>
                    {inUse ? (
                      <s-icon type="check" />
                    ) : (
                      <s-box inlineSize="20px" />
                    )}
                  </s-grid>
                </s-clickable>
              </s-stack>
            );
          })}
        </s-stack>
      </s-modal>

      {/*
       * What a name can be built from, for a merchant who does not yet know
       * there is anything to type. The same component the order reference
       * pattern uses, so the answer to "what can I put in here" looks the same
       * wherever it is asked.
       */}
      <PatternFieldsModal
        id={FIELDS_MODAL_ID}
        heading="What you can put in a name"
        resolvedAgainst={
          patternSample ? `${patternSample.sku}` : "one of your own products"
        }
        groups={pickerRowsFor("")}
      />

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
        {/*
         * The explanatory line sits under the control, at the card's own left
         * edge, rather than in the checkbox's `details` — which indents it to
         * clear the box and leaves a ragged gap down the left of every card.
         * Every checkbox on this page states its detail this way.
         */}
        <s-section heading="Product sync">
          <s-stack direction="block" gap="small-400">
            <s-checkbox
              name="enabled"
              value="on"
              label="Sync products to MetaKocka"
              checked={state.enabled}
              onChange={(e) => set({ enabled: e.currentTarget.checked })}
            />
            <s-text color="subdued">
              Names, new products and prices. Nothing is written to MetaKocka
              while this is off.
            </s-text>
          </s-stack>
        </s-section>

        {/*
          * Syncing on a schedule.
          *
          * Outside the `enabled` branch on purpose: re-reading and re-matching
          * the two catalogues is worth doing whether or not anything is written
          * back. A registry that is only as fresh as the last time somebody
          * pressed a button silently stops matching — a product renamed in
          * MetaKocka, a SKU corrected in Shopify, a variant added this morning
          * — and the first anyone hears of it is an order that cannot be sent.
          */}
        <s-section heading="Automatic syncing">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-400">
              <s-checkbox
                name="scheduleEnabled"
                value="on"
                label="Sync on a schedule"
                checked={state.scheduleEnabled}
                onChange={(e) =>
                  set({ scheduleEnabled: e.currentTarget.checked })
                }
              />
              <s-text color="subdued">
                Reads both catalogues and matches them without anyone pressing
                the button.
                {state.enabled
                  ? " Because product sync is on, it also writes names and prices to MetaKocka."
                  : " Nothing is written to MetaKocka while product sync is off."}
              </s-text>
            </s-stack>

            {state.scheduleEnabled ? (
              /*
               * The interval's explanation is a sibling line, not the field's
               * `details`: `details` is laid out to the field's own width, so a
               * sentence under a 260px number box wraps into a narrow ragged
               * column beside a lot of empty card. Every other explanation on
               * this page sits at the card's left edge, and so does this one.
               */
              <s-stack direction="block" gap="small-400">
                <s-box maxInlineSize="200px">
                  <s-number-field
                    name="scheduleIntervalMinutes"
                    // §2.8: labels state their units.
                    label="Sync every (minutes)"
                    min={15}
                    max={10080}
                    value={state.scheduleIntervalMinutes}
                    onChange={(e) =>
                      set({ scheduleIntervalMinutes: e.currentTarget.value })
                    }
                  />
                </s-box>
                <s-text color="subdued">
                  Twelve hours by default.
                </s-text>
              </s-stack>
            ) : null}

            {/*
             * Stock stays on the card rather than behind the disclosure: it is
             * the answer to "does this schedule control my stock", and a
             * merchant who does not think to ask is exactly the one who needs
             * to read it.
             */}
            <s-text color="subdued">
              Stock is separate and always automatic: it is read from MetaKocka
              every five minutes, and immediately when MetaKocka sends a stock
              update.
            </s-text>

            <LearnMore label="How often is worth it">
              <s-paragraph>
                MetaKocka has no bulk endpoint, so a full sync reads the
                catalogue a page at a time and is slow on a large one. Once or
                twice a day suits most catalogues; anything from a quarter of an
                hour to a week is accepted.
              </s-paragraph>
              <s-paragraph>
                Matching is worth running on its own schedule even with product
                sync off: a product renamed in MetaKocka, a SKU corrected in
                Shopify or a variant added this morning all change what matches,
                and a catalogue only as fresh as the last time somebody pressed
                the button stops matching quietly.
              </s-paragraph>
            </LearnMore>
          </s-stack>
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

                <PatternEditor
                  label="Product name in MetaKocka"
                  value={state.nameTemplate}
                  onChange={(next) => {
                    setTouched(true);
                    set({ nameTemplate: next });
                  }}
                  registry={registry}
                  rows={pickerRowsFor}
                  preview={
                    resolvedName
                      ? `${patternSample?.sku}: ${resolvedName}`
                      : null
                  }
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

                {/*
                 * Bordered. A tertiary button is text with a click handler,
                 * and sitting on its own between two cards it read as a
                 * heading nobody could press.
                 */}
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={FIELDS_MODAL_ID}
                  >
                    What you can put in a name
                  </s-button>
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={PATTERNS_MODAL_ID}
                  >
                    Start from a ready pattern
                  </s-button>
                </s-stack>

                {/*
                 * The foot of the card was a button, then a stray sentence,
                 * then another button, each on its own line and none of them
                 * obviously related. Two rows now: what helps you write a name,
                 * then what that name would do — the count beside the button
                 * that explains it, the way Refresh now and "Last read" sit
                 * together further down the page.
                 */}
                <s-divider />

                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={PREVIEW_MODAL_ID}
                  >
                    See what changes
                  </s-button>
                  <s-text color="subdued">
                    {previewSummary(preview.totals)}
                  </s-text>
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="New products">
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-400">
                  <s-checkbox
                    name="createMissing"
                    value="on"
                    label="Create missing products in MetaKocka"
                    checked={state.createMissing}
                    onChange={(e) =>
                      set({ createMissing: e.currentTarget.checked })
                    }
                  />
                  <s-text color="subdued">
                    Uses the SKU as the code, the name above, and the barcode.
                  </s-text>
                </s-stack>

                <s-stack direction="block" gap="small-400">
                  <s-checkbox
                    name="sendPricing"
                    value="on"
                    label="Give a new product its Shopify price"
                    checked={state.sendPricing}
                    onChange={(e) =>
                      set({ sendPricing: e.currentTarget.checked })
                    }
                  />
                  <s-text color="subdued">
                    Applies only as a product is created.
                  </s-text>
                </s-stack>

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
        <s-section heading="Prices and tax">
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

            {state.enabled ? <s-divider /> : null}

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

            {pricelistByHand || !canChoose ? (
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
                {/*
                 * A button, not a bare link: standing on its own under a field
                 * rather than inside a sentence, a line of blue text reads as a
                 * caption. The order settings page settled this the same way.
                 */}
                <s-stack direction="inline">
                  <s-button
                    variant="secondary"
                    href={METAKOCKA_PRICELISTS_URL}
                    target="_blank"
                    icon="external"
                  >
                    Open pricelists in MetaKocka
                  </s-button>
                </s-stack>
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

            {/*
              Three different facts, and only one of them is a problem.

              A code nobody has priced anything on is ordinary — a brand new
              pricelist looks exactly like this and refusing it would block the
              merchant on our inability to ask (§3: MetaKocka cannot list
              pricelists). A code that *was* priced and is not any more is worth
              saying out loud, because a setting is still pointing at it and the
              next sync will write a price into it. And a register that came
              back empty explains why there is nothing to choose from, which is
              otherwise an unexplained missing dropdown.
            */}
            {chosenVanished ? (
              <s-text color="subdued">
                MetaKocka has no priced product on this code any more. It was
                last seen{" "}
                {chosen?.lastSeenAt ? formatDateTime(chosen.lastSeenAt) : null}.
                Check the pricelist still exists in MetaKocka before the next
                sync sends a price to it.
              </s-text>
            ) : state.pricelistCode !== "" && !chosen ? (
              <s-text color="subdued">
                No priced product uses this code, so it could not be confirmed.
                That is expected for a pricelist you have just made.
              </s-text>
            ) : null}

            {registerEmptied ? (
              <s-text color="subdued">
                Nothing to choose from: no product in MetaKocka has a price on
                it, so no pricelist can be found. Type the code by hand, exactly
                as it appears in MetaKocka.
              </s-text>
            ) : null}

            <s-stack direction="inline" gap="base" alignItems="center">
              {canChoose ? (
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

            <s-divider />

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

            {/*
             * Folded, because a pricelist's type is fixed when it is created
             * and the catalogue usually tells us which it is — but a pricelist
             * with nothing priced on it cannot be read, so it still has to be
             * settable.
             */}
            <Advanced
              summary={
                /* Named, because "Prices include tax." beside the word
                   Advanced says nothing: whose prices, on what. */
                pricelistName
                  ? `Prices on ${pricelistName} ${state.pricelistBasis === "gross" ? "include" : "exclude"} tax.`
                  : `Pricelist prices ${state.pricelistBasis === "gross" ? "include" : "exclude"} tax.`
              }
            >
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
            </Advanced>
          </s-stack>
        </s-section>

        {/*
         * Everything a merchant almost never opens, in one card at the foot of
         * the page rather than as a card each between the ones they came for.
         *
         * Product type is the first thing in it and will not be the last, so
         * the inside is built as groups under their own headings: another
         * setting is another group, not another card.
         */}
        <AdvancedSection
          summary={`New products are marked ${joinLabels(typeLabels(state))}.${
            state.updateProductType
              ? " Products MetaKocka already has are set to match."
              : ""
          }`}
        >
          <s-stack direction="block" gap="large-100">
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-400">
                <s-heading>Product type in MetaKocka</s-heading>
                <s-text color="subdued">
                  MetaKocka files an article as a sales item, a purchase item, a
                  service, or a combination of them.
                </s-text>
              </s-stack>

              <s-stack direction="block" gap="small-400">
                <s-checkbox
                  name="productSales"
                  value="on"
                  label="Sales"
                  checked={state.productSales}
                  onChange={(e) =>
                    set({ productSales: e.currentTarget.checked })
                  }
                />
                <s-checkbox
                  name="productPurchasing"
                  value="on"
                  label="Purchase"
                  checked={state.productPurchasing}
                  onChange={(e) =>
                    set({ productPurchasing: e.currentTarget.checked })
                  }
                />
                <s-checkbox
                  name="productService"
                  value="on"
                  label="Service"
                  checked={state.productService}
                  onChange={(e) =>
                    set({ productService: e.currentTarget.checked })
                  }
                />
                {/*
                 * Red, inline and persistent (§2.8), under the group it belongs
                 * to rather than beside one box: the rule is about all three
                 * together.
                 */}
                {errorFor("productType") ? (
                  <s-text tone="critical">{errorFor("productType")}</s-text>
                ) : null}
                {/*
                 * Said once, plainly, where the missing boxes would be. A
                 * merchant comparing this card with the MetaKocka screen counts
                 * five boxes there and three here, and deserves to know why
                 * rather than to assume a bug.
                 */}
                <s-text color="subdued">
                  MetaKocka also shows Work and Fixed asset. Its API cannot set
                  those, so tick them in MetaKocka itself if you need them.
                </s-text>
              </s-stack>

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
                    name="updateProductType"
                    value="on"
                    label="Keep the product type up to date from here"
                    checked={state.updateProductType}
                    onChange={(e) =>
                      set({ updateProductType: e.currentTarget.checked })
                    }
                  />
                  <s-text color="subdued">
                    Every sync sets these boxes on every matched product, not
                    only on new ones.
                  </s-text>
                  <OverwriteWarning
                    saved={settings.updateProductType}
                    current={state.updateProductType}
                    heading="Shopify becomes the product type master"
                  >
                    {`Save this and the next sync marks every matched product ${joinLabels(typeLabels(state))} in MetaKocka, including products changed there.`}
                  </OverwriteWarning>
                </s-stack>
              </s-box>
            </s-stack>
          </s-stack>
        </AdvancedSection>

        {/*
         * The way back, where the page actually ends.
         *
         * §2.6 is satisfied by the breadcrumb in the header, and the header is
         * where a merchant who has just arrived looks. It is not where one who
         * has just finished the last field is: that is several screens down, and
         * further still at 375 px. Products is in the app nav, but this page is
         * not — it is reached from a button on Products — so the trip back is
         * the one piece of navigation the nav cannot make obvious.
         *
         * A button rather than a line of blue text, for the reason the Products
         * page gives for the button that leads here: under a paragraph, a link
         * reads as a footnote. Navigation rather than an action, so it does not
         * become a second Save beside the contextual save bar.
         */}
        <s-stack direction="inline">
          <s-button variant="secondary" href="/app/products">
            Back to products
          </s-button>
        </s-stack>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
