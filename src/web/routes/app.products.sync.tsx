import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
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
import { taxFactorFromPercent } from "~/adapters/metakocka/products";
import { listVariantDetails } from "~/adapters/shopify/products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  EXAMPLE_VARIANT,
  NAME_TOKENS,
  renderName,
  TEMPLATE_PRESETS,
  type VariantFacts,
} from "~/domain/products/name-template";
import {
  DEFAULT_UNIT,
  METAKOCKA_UNITS,
  isKnownUnit,
} from "~/domain/products/units";
import { Dropdown } from "~/web/components/dropdown";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Settings for writing product names into MetaKocka (CLAUDE.md §8.9).
 *
 * Every switch here defaults to off. This is the only place in the app that
 * writes into the ERP's catalogue, so nothing happens until the merchant says
 * it should, and the preview shows exactly what a name will look like before a
 * single call is made.
 *
 * Grouped sections and the contextual save bar, per §2.6.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [settings, samples] = await Promise.all([
    getProductSyncSetting(principal),
    // One page of a few variants: enough to preview a template against real
    // products without reading the whole catalogue on a settings page (§2.5).
    listVariantDetails(admin, { first: 5, maxPages: 1 }),
  ]);

  return {
    settings: {
      ...settings,
      lastRunAt: settings.lastRunAt?.toISOString() ?? null,
    },
    samples: samples.slice(0, 3),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
      message: `"${unit}" is not a unit in MetaKocka's register. Choose one from the list.`,
    };
  }

  if (nameTemplate === "") {
    return {
      ok: false,
      message:
        "The name template cannot be empty. Use at least one token, for example {title}.",
    };
  }

  // §3: a pricelist cannot be created through the API, so a price with no
  // pricelist to go in has nowhere to land.
  if (sendPricing && pricelistCode === "") {
    return {
      ok: false,
      message:
        "Sending prices needs the code of a pricelist that already exists in MetaKocka. Add the pricelist code, or turn prices off.",
    };
  }

  if (taxPercent !== "" && taxFactorFromPercent(taxPercent) === null) {
    return {
      ok: false,
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

  return { ok: true, message: "Saved product sync settings." };
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

export default function ProductSyncSettings() {
  const { settings, samples } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);

  const [state, setState] = useState<FormState>(() => toState(settings));

  // Type-ahead: the merchant types the name in the field and the tokens are
  // suggested as they go. Typing "{" (or any word after it) filters the list,
  // and choosing one drops it into the field. No syntax to learn, and no
  // separate builder to keep in step with the text.
  const template = state.nameTemplate;
  const partial = /\{([A-Za-z0-9_]*)$/.exec(template);
  const typed = (partial?.[1] ?? "").toLowerCase();

  const suggestions = NAME_TOKENS.filter((token) => {
    if (partial === null) return true;
    return (
      token.token.slice(1, -1).toLowerCase().startsWith(typed) ||
      token.label.toLowerCase().includes(typed)
    );
  }).slice(0, 8);

  const insertToken = (token: string) => {
    const next =
      partial === null
        ? `${template}${template === "" || template.endsWith(" ") ? "" : " "}${token}`
        : `${template.slice(0, partial.index)}${token}`;
    set({ nameTemplate: next });
  };

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const handleReset = () => setState(toState(settings));
    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [settings]);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const set = (patch: Partial<FormState>) =>
    setState((current) => ({ ...current, ...patch }));

  // The preview runs the same pure function the job runs, in the browser, so
  // what the merchant sees here is exactly what MetaKocka will be sent.
  const previewFrom: VariantFacts[] =
    samples.length > 0 ? samples : [EXAMPLE_VARIANT];

  return (
    <s-page heading="Product sync settings">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

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
                    ? "Every sync sets the name from the template. Names edited in MetaKocka will be overwritten."
                    : state.namePolicy === "when_empty"
                      ? "A product that already has a name keeps it. Only nameless products are filled in."
                      : "Existing products are never renamed. Only new ones get a name, and only if creating them is turned on below."}
                </s-text>
              </s-stack>
            </s-section>

            <s-section heading="How the name is built">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Type the name as you want it to read. Type {"{"} to bring up
                  what Shopify can fill in, or pick from the suggestions under
                  the field. A piece that has no value on a product disappears
                  from that product's name.
                </s-paragraph>

                <s-text-field
                  name="nameTemplate"
                  label="Product name in MetaKocka"
                  placeholder="{title} {options}"
                  value={state.nameTemplate}
                  onChange={(e) => set({ nameTemplate: e.currentTarget.value })}
                />

                <s-stack direction="block" gap="small-300">
                  <s-text color="subdued">
                    {partial === null
                      ? "Add to the name:"
                      : `Matching "${typed}":`}
                  </s-text>
                  {suggestions.length === 0 ? (
                    <s-text color="subdued">
                      Nothing matches what you typed. Clear it to see the whole
                      list.
                    </s-text>
                  ) : (
                    <s-grid
                      gridTemplateColumns="repeat(auto-fill, minmax(190px, 1fr))"
                      gap="small-300"
                    >
                      {suggestions.map((token) => (
                        <s-clickable-chip
                          key={token.token}
                          onClick={() => insertToken(token.token)}
                        >
                          {`${token.label} — ${token.example}`}
                        </s-clickable-chip>
                      ))}
                    </s-grid>
                  )}
                </s-stack>

                <s-stack direction="block" gap="small-300">
                  <s-text color="subdued">
                    Or start from a ready pattern:
                  </s-text>
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    {TEMPLATE_PRESETS.map((preset) => (
                      <s-button
                        key={preset.id}
                        type="button"
                        variant="tertiary"
                        onClick={() => set({ nameTemplate: preset.template })}
                      >
                        {preset.label}
                      </s-button>
                    ))}
                  </s-stack>
                </s-stack>

                <s-stack direction="block" gap="small-300">
                  <s-text type="strong">
                    {samples.length > 0
                      ? "Your products would be called"
                      : "An example product would be called"}
                  </s-text>
                  {previewFrom.map((variant, index) => (
                    <s-text key={index}>
                      {`${variant.sku} — ${renderName(template, variant)}`}
                    </s-text>
                  ))}
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
