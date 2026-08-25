import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useActionData,
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
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Settings for writing product names and prices into MetaKocka (CLAUDE.md §8.9).
 *
 * Every switch here defaults to off. This is the only place in the app that
 * writes into the ERP's catalogue, so nothing happens until the merchant says
 * it should, and the preview shows what every name becomes before a single
 * call is made.
 *
 * The preview, the lint and the save check all run through
 * `domain/products/template`, the same entry point the sync job uses.
 * `tests/unit/template-agreement.test.ts` holds them to each other.
 *
 * Sections follow `docs/ui-conventions.md`: the two settings that overwrite
 * data the merchant keeps elsewhere — the name and the price — are separate,
 * each headed by what it does, and each carries the same three-part treatment
 * and no more.
 */

/**
 * How many of the merchant's products the preview covers.
 *
 * Enough rows to see a pattern behave on more than one shape of product, few
 * enough that a settings page reads one small page of the catalogue rather than
 * all of it (§2.5). The lint runs over the same set, so what blocks saving is
 * exactly what the merchant can see — and the screen says so, because twelve
 * rows out of a large catalogue is a sample, not an answer.
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
   * Keep the pricelist register current without ever waiting on it.
   *
   * A nightly job already refreshes it. This covers what the nightly job
   * cannot: a shop that connected MetaKocka an hour ago, and a merchant who
   * made a pricelist this morning and came straight here. Enqueued, never
   * awaited — a MetaKocka call takes tens of seconds and no page load may wait
   * on one (§2.5), so the screen renders from the database and the fresh list
   * arrives underneath it.
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
      ...entry,
      observedAt: entry.observedAt?.toISOString() ?? null,
    })),
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
   *
   * This reads a page of variants, which a page load may not do for MetaKocka
   * but an action may do for Shopify: one small GraphQL call on an explicit
   * save, not on every render. Two names that collide would become one product
   * in the ERP, so it is worth the call.
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
   * Every sales order this app writes carries it as `sales_pricelist_code`, so
   * this is required whether or not product prices are being synced — a
   * document filed against no pricelist gives whoever opens it in MetaKocka no
   * way to see which prices applied.
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
   * against a net that matches no pricelist and understates the VAT — so an
   * empty field is refused rather than defaulted.
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
 * What the preview covers, said plainly.
 *
 * The one thing this must never do is let a sample read as the catalogue. A
 * merchant with twelve thousand variants seeing twelve rows has been shown
 * roughly a thousandth of what a sync would touch, and every count on this
 * screen — the table and the lint alike — is out of those twelve.
 */
function previewScope(shown: number, catalogue: VariantCount | null): string {
  if (shown === 0) return "";
  if (!catalogue) {
    return `Checked against ${shown} of your product variants. Anything not shown here has not been checked.`;
  }
  if (catalogue.exact && catalogue.count <= shown) {
    return `Checked against all ${NUMBER.format(catalogue.count)} of your product variants.`;
  }

  const total = catalogue.exact
    ? NUMBER.format(catalogue.count)
    : `more than ${NUMBER.format(catalogue.count)}`;
  return `Checked against ${shown} of your ${total} product variants. Anything not shown here has not been checked.`;
}

export default function ProductSyncSettings() {
  const {
    settings,
    samples,
    definitions,
    catalogue,
    currentNames,
    pricelists,
    taxRates,
    connected,
    refreshing,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const reloader = useFetcher<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);

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

  const set = (patch: Partial<FormState>) =>
    setState((current) => ({ ...current, ...patch }));

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
   * function the sync job calls. Nothing here reaches MetaKocka: the current
   * names came from our registry with the page, and the new ones are worked out
   * in the browser.
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

  // The field's own message. A parse error is about the character under the
  // caret, so it wins over a lint rule about the resulting names.
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
  const loadingPricelists =
    refreshing ||
    reloader.state === "submitting" ||
    reloader.state === "loading";
  const reloadFailed = reloader.data && !reloader.data.ok;

  const chosen = pricelists.find((entry) => entry.code === state.pricelistCode);
  const pricelistOptions = pricelists.map((entry) => ({
    value: entry.code,
    label: entry.title ? `${entry.code} — ${entry.title}` : entry.code,
  }));

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handleReset = () => {
      setState(toState(settings));
      setTouched(false);
    };
    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [settings]);

  useEffect(() => {
    if (!result?.ok) return;
    setTouched(false);
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="Product sync settings">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-stack direction="block" gap="large">
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {/*
         * Saving is blocked in the action, not by cancelling the submit here:
         * that would leave Shopify's save bar mid-save with nothing to show for
         * it. The merchant already has the reason on screen — the banner under
         * the name is computed as they type.
         */}
        <Form method="post" data-save-bar ref={formRef}>
          <s-stack direction="block" gap="large">
            <s-section heading="Sending names to MetaKocka">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Shopify owns the customer-facing title; MetaKocka owns
                  everything else about a product.
                </s-paragraph>
                <s-checkbox
                  name="enabled"
                  value="on"
                  label="Send product names to MetaKocka"
                  details="Nothing is written while this is off."
                  checked={state.enabled}
                  onChange={(e) => set({ enabled: e.currentTarget.checked })}
                />
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
                {/* Part 1 of the overwrite pattern: always present, names what
                    is overwritten and how often. */}
                <s-text color="subdued">
                  {state.namePolicy === "always"
                    ? "Every sync replaces the name in MetaKocka. A name edited there is overwritten on the next run."
                    : state.namePolicy === "when_empty"
                      ? "A MetaKocka product that already has a name keeps it. Only nameless ones are filled in."
                      : "Existing MetaKocka products are never renamed. Only newly created ones get a name."}
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
              </s-stack>
            </s-section>

            <s-section heading="How the name is built">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Type the name as it should read, and type {"{"} to add
                  something Shopify knows. A field with no value on a product
                  disappears from that product&rsquo;s name.
                </s-paragraph>

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
                 * first and set the tone; the warnings ride along in the same
                 * block rather than in a second banner underneath it.
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
                  <s-text type="strong">Start from a ready pattern</s-text>
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
                               * The name this pattern gives one of the
                               * merchant's own products. A shop with an empty
                               * catalogue gets the pattern's name and no
                               * invented example beside it.
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

                <s-stack direction="block" gap="small-300">
                  <s-text type="strong">A sample of your products</s-text>
                  <s-text color="subdued">
                    {previewScope(preview.totals.rows, catalogue)}
                  </s-text>
                  <NamePreviewTable
                    rows={preview.rows}
                    empty="No Shopify variant has a SKU yet, so there is nothing to name."
                  />
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Creating products MetaKocka does not have">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  A SKU with no MetaKocka product cannot have its stock synced
                  and cannot appear on an order.
                </s-paragraph>

                <s-checkbox
                  name="createMissing"
                  value="on"
                  label="Create missing products in MetaKocka"
                  details="Creates a MetaKocka product with the SKU as its code, the name above, and the barcode."
                  checked={state.createMissing}
                  onChange={(e) =>
                    set({ createMissing: e.currentTarget.checked })
                  }
                />

                <s-checkbox
                  name="sendPricing"
                  value="on"
                  label="Give a new product its Shopify price"
                  details="Applies only as a product is created. Nothing is written to a MetaKocka product that already exists."
                  checked={state.sendPricing}
                  onChange={(e) =>
                    set({ sendPricing: e.currentTarget.checked })
                  }
                />

                <Dropdown
                  name="unit"
                  label="Unit of measure for new products"
                  details="MetaKocka needs a unit on every product and only accepts one from its own register."
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

            {/*
             * Its own section, because it is not about products MetaKocka is
             * missing — it is about every product it already has. Filed under
             * "products MetaKocka does not have" it read as a footnote to
             * creating articles, which is the opposite of its blast radius.
             */}
            <s-section heading="Replacing prices on products MetaKocka already has">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="updatePricing"
                  value="on"
                  label="Keep prices up to date from Shopify"
                  details="Every sync writes the Shopify price into the pricelist below, replacing the price MetaKocka holds."
                  checked={state.updatePricing}
                  disabled={!state.sendPricing}
                  onChange={(e) =>
                    set({ updatePricing: e.currentTarget.checked })
                  }
                />
                {state.sendPricing ? null : (
                  <s-text color="subdued">
                    Turn on &ldquo;Give a new product its Shopify price&rdquo;
                    above to use this. Prices are sent by one code path, and it
                    is off.
                  </s-text>
                )}
                {/*
                 * Gated on sending prices as well, because that is what the
                 * action stores: with it off nothing is overwritten, and a
                 * warning about a write that cannot happen is noise.
                 */}
                <OverwriteWarning
                  saved={settings.updatePricing}
                  current={state.updatePricing && state.sendPricing}
                  heading="Shopify becomes the price master"
                >
                  Save this and the next sync replaces the price of every
                  matched MetaKocka product, including prices edited in
                  MetaKocka.
                </OverwriteWarning>
              </s-stack>
            </s-section>

            <s-section heading="Where prices and tax are filed in MetaKocka">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Every sales order this app writes carries these, whether or
                  not product prices are synced.
                </s-paragraph>

                {loadingPricelists && pricelists.length === 0 ? (
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-spinner
                      size="base"
                      accessibilityLabel="Reading your pricelists"
                    />
                    <s-text color="subdued">
                      Reading your pricelists from MetaKocka.
                    </s-text>
                  </s-stack>
                ) : null}

                {reloadFailed ? (
                  <s-banner
                    tone="warning"
                    heading="Could not read your pricelists"
                  >
                    <s-paragraph>{reloader.data?.message}</s-paragraph>
                    <s-button
                      slot="primary-action"
                      type="button"
                      onClick={() =>
                        reloader.submit(
                          { intent: "load-pricelists" },
                          { method: "post" },
                        )
                      }
                    >
                      Try again
                    </s-button>
                  </s-banner>
                ) : null}

                {pricelistByHand || pricelistOptions.length === 0 ? (
                  <s-text-field
                    name="pricelistCode"
                    label="MetaKocka pricelist code"
                    details="The code exactly as it appears in MetaKocka. The API cannot create a pricelist."
                    value={state.pricelistCode}
                    onChange={(e) =>
                      set({ pricelistCode: e.currentTarget.value })
                    }
                    {...(errorFor("pricelistCode")
                      ? { error: errorFor("pricelistCode") }
                      : {})}
                  />
                ) : (
                  <Dropdown
                    name="pricelistCode"
                    label="MetaKocka pricelist"
                    details="Found on your own priced products. A pricelist with nothing priced on it does not appear here."
                    value={state.pricelistCode}
                    onChange={(next) => set({ pricelistCode: next })}
                    options={pricelistOptions}
                    {...(errorFor("pricelistCode")
                      ? { error: errorFor("pricelistCode") }
                      : {})}
                  />
                )}

                <s-stack direction="inline" gap="small-300" alignItems="center">
                  {pricelistOptions.length > 0 ? (
                    <s-button
                      type="button"
                      variant="tertiary"
                      onClick={() => setPricelistByHand((now) => !now)}
                    >
                      {pricelistByHand
                        ? "Choose from your pricelists"
                        : "Type a code instead"}
                    </s-button>
                  ) : null}
                  {connected ? (
                    <s-button
                      type="button"
                      variant="tertiary"
                      {...(loadingPricelists ? { loading: true } : {})}
                      onClick={() =>
                        reloader.submit(
                          { intent: "load-pricelists" },
                          { method: "post" },
                        )
                      }
                    >
                      Read pricelists from MetaKocka
                    </s-button>
                  ) : null}
                </s-stack>

                {state.pricelistCode !== "" && !chosen ? (
                  <s-text color="subdued">
                    No priced product uses this code, so it could not be
                    confirmed. That is expected for a pricelist you have just
                    made.
                  </s-text>
                ) : null}

                {/*
                 * A MetaKocka pricelist is created net or gross and cannot be
                 * either. Sending the wrong one is not a format error — the
                 * price lands wrong by the VAT rate — so the app restates the
                 * amount rather than only renaming the field. When a priced
                 * product told us which it is, that answer is offered here.
                 */}
                <Dropdown
                  name="pricelistBasis"
                  label="Prices on that pricelist are"
                  details={
                    chosen?.includesTax === null || chosen === undefined
                      ? "If this is wrong, the first sync says so and corrects itself."
                      : chosen.includesTax
                        ? "Your priced products say this pricelist is gross."
                        : "Your priced products say this pricelist is net."
                  }
                  value={state.pricelistBasis}
                  onChange={(next) => set({ pricelistBasis: next })}
                  options={[
                    { value: "gross", label: "Including tax (gross)" },
                    { value: "net", label: "Excluding tax (net)" },
                  ]}
                />

                <s-text-field
                  name="taxPercent"
                  label="Default VAT rate (%)"
                  details="Used on order lines when Shopify gives no rate, and to convert between net and gross prices."
                  value={state.taxPercent}
                  onChange={(e) => set({ taxPercent: e.currentTarget.value })}
                  {...(errorFor("taxPercent")
                    ? { error: errorFor("taxPercent") }
                    : {})}
                />
                {taxRates.length > 0 ? (
                  <s-stack direction="block" gap="small-400">
                    <s-text color="subdued">
                      Rates on your own MetaKocka products:
                    </s-text>
                    <s-stack
                      direction="inline"
                      gap="small-400"
                      alignItems="center"
                    >
                      {taxRates.map((rate) => (
                        <s-clickable-chip
                          key={rate}
                          onClick={() => set({ taxPercent: rate })}
                        >
                          {`${rate}%`}
                        </s-clickable-chip>
                      ))}
                    </s-stack>
                  </s-stack>
                ) : null}
              </s-stack>
            </s-section>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
