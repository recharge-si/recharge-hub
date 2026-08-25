import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getProductSyncSetting,
  saveProductSyncSetting,
} from "~/adapters/db/repositories/product-sync-setting.server";
import { metakockaNamesFor } from "~/adapters/db/repositories/sku.server";
import { taxFactorFromPercent } from "~/adapters/metakocka/products";
import {
  listMetafieldDefinitions,
  listVariantDetails,
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
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Settings for writing product names into MetaKocka (CLAUDE.md §8.9).
 *
 * Every switch here defaults to off. This is the only place in the app that
 * writes into the ERP's catalogue, so nothing happens until the merchant says
 * it should, and the preview shows what every name becomes before a single
 * call is made.
 *
 * The preview, the lint and the save check all run through
 * `domain/products/template`, which is the same entry point the sync job uses.
 * `tests/unit/template-agreement.test.ts` holds them to each other: a preview
 * that can disagree with the job is a promise the job then breaks across the
 * whole catalogue.
 *
 * Grouped sections and the contextual save bar, per §2.6.
 */

/**
 * How many of the merchant's products the preview covers.
 *
 * Enough rows to see a pattern behave on more than one shape of product, few
 * enough that a settings page reads one small page of the catalogue rather
 * than all of it (§2.5). The lint runs over the same set, so what blocks saving
 * is exactly what the merchant can see.
 */
const PREVIEW_SIZE = 12;

const previewOptions = { first: PREVIEW_SIZE, maxPages: 1, metafields: true };

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

  const [settings, samples, definitions] = await Promise.all([
    getProductSyncSetting(principal),
    listVariantDetails(admin, previewOptions),
    listMetafieldDefinitions(admin),
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

  return {
    settings: {
      ...settings,
      lastRunAt: settings.lastRunAt?.toISOString() ?? null,
    },
    samples,
    definitions,
    currentNames: [...currentNames.entries()],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const value = (name: string) => String(formData.get(name) ?? "").trim();
  const checked = (name: string) => formData.get(name) === "on";

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
   * but an action may do for Shopify: it is one small GraphQL call on an
   * explicit save, not on every render. Two names that collide would become one
   * product in the ERP, so it is worth the call.
   */
  const [samples, definitions] = await Promise.all([
    listVariantDetails(admin, previewOptions),
    listMetafieldDefinitions(admin),
  ]);

  const diagnostics = lintTemplate({
    nodes: parsed.nodes,
    variants: samples,
    knownMetafields: knownMetafieldPaths(definitions),
  });

  const blocking = diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (blocking) {
    return { ok: false, field: "nameTemplate", message: blocking.message };
  }

  // §3: a pricelist cannot be created through the API, so a price with no
  // pricelist to go in has nowhere to land.
  if (sendPricing && pricelistCode === "") {
    return {
      ok: false,
      field: "pricelistCode",
      message:
        "Sending prices needs the code of a pricelist that already exists in MetaKocka. Add the pricelist code, or turn prices off.",
    };
  }

  if (taxPercent !== "" && taxFactorFromPercent(taxPercent) === null) {
    return {
      ok: false,
      field: "taxPercent",
      message:
        "The tax rate must be a percentage between 0 and 100, for example 22. Leave it empty to let MetaKocka decide the tax.",
    };
  }

  await saveProductSyncSetting(principal, {
    enabled: checked("enabled"),
    nameTemplate,
    namePolicy,
    createMissing: checked("createMissing"),
    sendPricing,
    updatePricing: sendPricing && checked("updatePricing"),
    pricelistCode: pricelistCode || null,
    pricelistIncludesTax: value("pricelistBasis") !== "net",
    taxPercent: taxPercent || null,
    unit: unit,
  });

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

export default function ProductSyncSettings() {
  const { settings, samples, definitions, currentNames } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);

  const [state, setState] = useState<FormState>(() => toState(settings));
  // §2.8: no error before the merchant has had a chance to answer.
  const [touched, setTouched] = useState(false);

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

  const patternSample = samples[0] ?? null;

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
         * Saving is blocked in the action, not here. Cancelling the submit
         * would leave Shopify's save bar mid-save with nothing to show for it,
         * and the merchant already has the reason on screen: the banner below
         * is computed as they type, so a blocking rule is visible well before
         * they reach for Save.
         */}
        <Form method="post" data-save-bar ref={formRef}>
          <s-stack direction="block" gap="large">
            <s-section heading="Sending names to MetaKocka">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Shopify owns the customer-facing name and MetaKocka owns
                  everything else about a product. With this on, the app writes
                  the name below into MetaKocka. It never changes a price, a tax
                  rate or stock on a product that already exists.
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
                <s-text color="subdued">
                  {state.namePolicy === "always"
                    ? "Every sync sets the name from the pattern. Names edited in MetaKocka will be overwritten."
                    : state.namePolicy === "when_empty"
                      ? "A product that already has a name keeps it. Only nameless products are filled in."
                      : "Existing products are never renamed. Only new ones get a name, and only if creating them is turned on below."}
                </s-text>
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
                  <s-text type="strong">
                    {`What changes in MetaKocka (${preview.totals.rows} of your products)`}
                  </s-text>
                  <NamePreviewTable
                    rows={preview.rows}
                    empty="No Shopify variant has a SKU yet, so there is nothing to name."
                  />
                </s-stack>
              </s-stack>
            </s-section>

            <s-section heading="Products MetaKocka does not have">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  A Shopify SKU with no MetaKocka product cannot have its stock
                  synced and cannot appear on an order sent to the ERP. The app
                  can create the product for you, using the SKU as the code.
                </s-paragraph>

                <s-checkbox
                  name="createMissing"
                  value="on"
                  label="Create missing products in MetaKocka"
                  details="Creates a product with the SKU as its code, the name above, and the barcode."
                  checked={state.createMissing}
                  onChange={(e) =>
                    set({ createMissing: e.currentTarget.checked })
                  }
                />

                <s-checkbox
                  name="sendPricing"
                  value="on"
                  label="Also send the Shopify price and tax rate"
                  details="Sent when a product is created. Products MetaKocka already has keep their price unless you turn on the setting below."
                  checked={state.sendPricing}
                  onChange={(e) =>
                    set({ sendPricing: e.currentTarget.checked })
                  }
                />

                {state.sendPricing ? (
                  <s-stack direction="block" gap="base">
                    {/*
                     * Its own switch, and off by default. MetaKocka is master
                     * for price, so overwriting a price it already holds is a
                     * decision the merchant takes deliberately — but without
                     * this the pricing switch did nothing at all for a
                     * catalogue that already exists, which read as broken.
                     */}
                    <s-checkbox
                      name="updatePricing"
                      value="on"
                      label="Keep prices up to date on products MetaKocka already has"
                      details="Every sync writes the Shopify price into the pricelist below. Prices edited in MetaKocka will be overwritten."
                      checked={state.updatePricing}
                      onChange={(e) =>
                        set({ updatePricing: e.currentTarget.checked })
                      }
                    />
                    {state.updatePricing ? (
                      <s-banner
                        tone="warning"
                        heading="Shopify becomes the price master"
                      >
                        <s-paragraph>
                          While this is on, MetaKocka no longer decides prices
                          for products this app syncs. Anyone editing a price in
                          MetaKocka will see it replaced on the next sync.
                        </s-paragraph>
                      </s-banner>
                    ) : null}
                  </s-stack>
                ) : null}

                {/*
                 * Outside the pricing switch on purpose. Every sales order this
                 * app writes carries this pricelist as `sales_pricelist_code`,
                 * so it is needed whether or not product prices are being
                 * synced — a document filed against no pricelist gives whoever
                 * opens it in MetaKocka no way to see which prices applied.
                 */}
                <s-text-field
                  name="pricelistCode"
                  label="MetaKocka pricelist code"
                  details="Used on every sales order sent to MetaKocka, and for product prices if you turn those on. It must already exist in MetaKocka; the API cannot create one."
                  value={state.pricelistCode}
                  onChange={(e) =>
                    set({ pricelistCode: e.currentTarget.value })
                  }
                  {...(result && !result.ok && result.field === "pricelistCode"
                    ? { error: result.message }
                    : {})}
                />
                {/*
                 * A MetaKocka pricelist is created net or gross and cannot be
                 * either. Sending the wrong one is not a format error — the
                 * price lands wrong by the VAT rate — so the app restates the
                 * amount rather than only renaming the field. MetaKocka names
                 * the type it wants when this is wrong, and the sync corrects
                 * itself from that.
                 */}
                <Dropdown
                  name="pricelistBasis"
                  label="Prices on that pricelist are"
                  details="Check the pricelist in MetaKocka. If this is wrong, the first sync says so and corrects itself."
                  value={state.pricelistBasis}
                  onChange={(next) => set({ pricelistBasis: next })}
                  options={[
                    { value: "gross", label: "Including tax (gross)" },
                    { value: "net", label: "Excluding tax (net)" },
                  ]}
                />
                {/*
                 * Needed for orders, not just for prices. MetaKocka refuses a
                 * document line with no tax attribute and will not infer one
                 * from the catalogue, so when Shopify does not supply a rate —
                 * any shop with no tax registration for that market — this is
                 * what the line carries. Sending zero instead files the right
                 * gross against a net that matches no pricelist, and understates
                 * the VAT.
                 */}
                <s-text-field
                  name="taxPercent"
                  label="Default VAT rate (%)"
                  details="For example 22. Used on order lines when Shopify does not give a rate, and to convert between net and gross prices. Set it to the rate your pricelist uses."
                  value={state.taxPercent}
                  onChange={(e) => set({ taxPercent: e.currentTarget.value })}
                  {...(result && !result.ok && result.field === "taxPercent"
                    ? { error: result.message }
                    : {})}
                />

                {state.sendPricing ? null : (
                  <s-text color="subdued">
                    Product prices are not being written to MetaKocka. Turn on
                    sending prices above if you want them synced as well.
                  </s-text>
                )}

                <Dropdown
                  name="unit"
                  label="Unit of measure for new products"
                  details="MetaKocka needs a unit on every product, and only accepts one from its own register. Most Slovenian companies sell in kos."
                  value={state.unit}
                  onChange={(next) => set({ unit: next })}
                  options={METAKOCKA_UNITS.map((unit) => ({
                    value: unit,
                    label: unit,
                  }))}
                  {...(result && !result.ok && result.field === "unit"
                    ? { error: result.message }
                    : {})}
                />
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
