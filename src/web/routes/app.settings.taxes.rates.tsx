import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  deleteCountryRate,
  getTaxConfig,
  listMerchantCountryRates,
  upsertCountryRate,
} from "~/adapters/db/repositories/tax.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { effectiveCountryRates, mappingFor } from "~/domain/tax/config";
import { TAX_ROUTES } from "~/domain/tax/diagnostics";
import { countryName, referenceCountryRates } from "~/domain/tax/eu";
import {
  formatRateKey,
  rateKeyFromPercent,
  sameRate,
} from "~/domain/tax/rates";
import type { CountryRateKind } from "~/domain/tax/types";
import { principalFromSession } from "~/web/lib/principal.server";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * EU VAT rates: what this app expects Shopify to have charged per country
 * (§21 of the brief).
 *
 * Validation data, and it says so. An order is filed with Shopify's rate; this
 * table only decides whether that rate was expected, which is what turns a
 * surprising 10% into a note on the order rather than silence. The reference
 * rates ship with the app; a merchant's edit replaces the reference for that
 * country and kind and is stored as theirs, so the origin of every number on
 * the page is visible.
 */
const SAVE_BAR_ID = "tax-rates-save-bar";

interface Row {
  country: string;
  name: string;
  standard: string;
  /** Reduced rates, comma separated, as typed. */
  reduced: string;
  /** Super-reduced and parking, shown but not edited here. */
  other: string[];
  standardOrigin: "reference" | "merchant";
  reducedOrigin: "reference" | "merchant";
  standardMapped: boolean;
}

function join(rates: string[]): string {
  return rates.join(", ");
}

/**
 * A reduced rate. The table holds one row per (country, kind), so a second
 * merchant-entered reduced rate is stored as `other` labelled "reduced".
 */
function isReduced(row: {
  kind: CountryRateKind;
  label: string | null;
}): boolean {
  return (
    row.kind === "reduced" || (row.kind === "other" && row.label === "reduced")
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [config, merchant] = await Promise.all([
    getTaxConfig(principal),
    listMerchantCountryRates(principal),
  ]);
  const effective = effectiveCountryRates(merchant);
  const countries = [...new Set(effective.map((row) => row.country))].sort(
    (a, b) => countryName(a).localeCompare(countryName(b)),
  );

  const rows: Row[] = countries.map((country) => {
    const rates = effective.filter((row) => row.country === country);
    const standard = rates.find((row) => row.kind === "standard");
    const reduced = rates.filter(isReduced);
    return {
      country,
      name: countryName(country),
      standard: standard?.rateKey ?? "",
      reduced: join(reduced.map((row) => row.rateKey)),
      other: rates
        .filter((row) => row.kind !== "standard" && !isReduced(row))
        .map(
          (row) =>
            `${row.kind.replace("_", " ")} ${formatRateKey(row.rateKey)}`,
        ),
      standardOrigin: standard?.origin ?? "reference",
      reducedOrigin: reduced.some((row) => row.origin === "merchant")
        ? "merchant"
        : "reference",
      standardMapped: standard
        ? mappingFor(config, standard.rateKey) !== null
        : false,
    };
  });

  return { rows, domesticCountry: config.domesticCountry };
};

const formSchema = z.array(
  z.object({
    country: z.string().trim().length(2),
    standard: z.string().trim(),
    reduced: z.string().trim(),
  }),
);

type SaveResult =
  | { ok: true; message: string }
  | { ok: false; field?: string; message: string };

/**
 * The reference for a country and kind, as the string the form shows, so a
 * value typed back to the reference removes the override instead of storing
 * a copy of it.
 */
function reference(country: string, kind: CountryRateKind): string[] {
  return referenceCountryRates()
    .filter((row) => row.country === country && row.kind === kind)
    .map((row) => row.rateKey);
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SaveResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  let json: unknown;
  try {
    json = JSON.parse(String((await request.formData()).get("rows") ?? ""));
  } catch {
    return {
      ok: false,
      message: "The rates could not be read. Reload the page and try again.",
    };
  }
  const parsed = formSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: "The rates could not be read. Reload the page and try again.",
    };
  }

  /*
   * What the merchant's own rows should be after this save: a row wherever
   * the form differs from the reference, none where it matches. Then only the
   * difference against the rows that exist is written, so saving a page with
   * one edit is one write and not eighty.
   */
  const desired = new Map<
    string,
    {
      country: string;
      kind: CountryRateKind;
      rateKey: string;
      label: string | null;
    }
  >();

  for (const row of parsed.data) {
    const country = row.country.toUpperCase();

    const standard =
      row.standard === "" ? null : rateKeyFromPercent(row.standard);
    if (row.standard !== "" && standard === null) {
      return {
        ok: false,
        field: `${country}:standard`,
        message: `The standard rate for ${countryName(country)} must be a percentage between 0 and 100.`,
      };
    }

    const reducedKeys: string[] = [];
    for (const part of row.reduced
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const key = rateKeyFromPercent(part);
      if (key === null) {
        return {
          ok: false,
          field: `${country}:reduced`,
          message: `"${part}" is not a rate. Reduced rates for ${countryName(country)} are percentages separated by commas, for example 5, 9.5.`,
        };
      }
      reducedKeys.push(key);
    }
    if (reducedKeys.length > 2) {
      return {
        ok: false,
        field: `${country}:reduced`,
        message: `Up to two reduced rates per country. ${countryName(country)} lists ${reducedKeys.length}.`,
      };
    }

    const [refStandard] = reference(country, "standard");
    const refReduced = reference(country, "reduced");

    if (standard !== null && !sameRate(standard, refStandard ?? null)) {
      desired.set(`${country}:standard`, {
        country,
        kind: "standard",
        rateKey: standard,
        label: null,
      });
    }

    const sameReduced =
      reducedKeys.length === refReduced.length &&
      reducedKeys.every((key, index) =>
        sameRate(key, refReduced[index] ?? null),
      );
    if (!sameReduced) {
      if (reducedKeys[0] !== undefined) {
        desired.set(`${country}:reduced`, {
          country,
          kind: "reduced",
          rateKey: reducedKeys[0],
          label: null,
        });
      }
      if (reducedKeys[1] !== undefined) {
        desired.set(`${country}:other`, {
          country,
          kind: "other",
          rateKey: reducedKeys[1],
          label: "reduced",
        });
      }
    }
  }

  const existing = await listMerchantCountryRates(principal);
  const changes: string[] = [];

  for (const row of existing) {
    if (
      row.kind !== "standard" &&
      row.kind !== "reduced" &&
      row.kind !== "other"
    )
      continue;
    const want = desired.get(`${row.country}:${row.kind}`);
    if (!want) {
      await deleteCountryRate(principal, {
        country: row.country,
        kind: row.kind,
      });
      changes.push(`${row.country} ${row.kind}: back to reference`);
    }
  }
  for (const [key, want] of desired) {
    const current = existing.find(
      (row) => `${row.country}:${row.kind}` === key,
    );
    if (
      current &&
      sameRate(current.rateKey, want.rateKey) &&
      current.label === want.label
    )
      continue;
    await upsertCountryRate(principal, want);
    changes.push(`${want.country} ${want.kind}: ${want.rateKey}`);
  }

  if (changes.length > 0) {
    await appendEvent(principal, {
      entityType: "country_vat_rate",
      event: "tax.country_rates.saved",
      detail: { changes },
    });
  }

  return {
    ok: true,
    message:
      changes.length === 0
        ? "Nothing changed."
        : "Saved the country VAT rates.",
  };
};

function normalise(rows: Row[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      country: row.country,
      standard: rateKeyFromPercent(row.standard) ?? row.standard,
      reduced: row.reduced
        .split(",")
        .map((value) => rateKeyFromPercent(value.trim()) ?? value.trim())
        .filter(Boolean)
        .join(","),
    })),
  );
}

export default function TaxRates() {
  const { rows: saved, domesticCountry } = useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const saving = saver.state !== "idle";
  const result = saver.data;

  const [rows, setRows] = useState<Row[]>(saved);
  const [query, setQuery] = useState("");

  const savedKey = normalise(saved);
  const reset = useCallback(() => setRows(saved), [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(rows) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const update = (country: string, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) =>
        row.country === country ? { ...row, ...patch } : row,
      ),
    );

  const save = () =>
    saver.submit(
      {
        rows: JSON.stringify(
          rows.map(({ country, standard, reduced }) => ({
            country,
            standard,
            reduced,
          })),
        ),
      },
      { method: "post" },
    );

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      needle === "" ||
      row.name.toLowerCase().includes(needle) ||
      row.country.toLowerCase() === needle,
  );

  return (
    <s-page heading="EU VAT rates">
      <s-link slot="breadcrumb-actions" href={TAX_ROUTES.overview}>
        Taxes & VAT
      </s-link>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(saving ? { loading: "" } : {})}
        >
          Save
        </button>
        <button onClick={reset}>Discard</button>
      </ui-save-bar>

      <s-stack direction="block" gap="large">
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Rates by country">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              What this app expects Shopify to charge for each destination. An
              order is always filed with the rate Shopify actually charged; a
              rate not listed here is noted on the order, never replaced.
            </s-paragraph>
            <s-text color="subdued">
              Reference rates as published by the European Commission, September
              2026. Edit a rate to replace the reference for that country; type
              the reference back to restore it.
            </s-text>

            <s-box maxInlineSize="320px">
              <s-text-field
                name="query"
                label="Find a country"
                labelAccessibilityVisibility="exclusive"
                placeholder="Find a country"
                icon="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </s-box>

            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Country</s-table-header>
                <s-table-header listSlot="labeled">
                  Standard VAT (%)
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Reduced rates (%)
                </s-table-header>
                <s-table-header listSlot="labeled">Source</s-table-header>
                <s-table-header listSlot="labeled">
                  Standard rate mapped
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visible.map((row) => (
                  <s-table-row key={row.country}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{row.name}</s-text>
                        <s-text color="subdued">
                          {row.country === domesticCountry
                            ? `${row.country} · home country`
                            : row.country}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-box maxInlineSize="120px">
                        <s-text-field
                          name={`standard-${row.country}`}
                          label={`Standard VAT rate for ${row.name}`}
                          labelAccessibilityVisibility="exclusive"
                          value={row.standard}
                          onChange={(event) =>
                            update(row.country, {
                              standard: event.currentTarget.value,
                            })
                          }
                          {...(errorFor(`${row.country}:standard`)
                            ? { error: errorFor(`${row.country}:standard`) }
                            : {})}
                        />
                      </s-box>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-box maxInlineSize="160px">
                          <s-text-field
                            name={`reduced-${row.country}`}
                            label={`Reduced VAT rates for ${row.name}`}
                            labelAccessibilityVisibility="exclusive"
                            placeholder="For example 5, 9.5"
                            value={row.reduced}
                            onChange={(event) =>
                              update(row.country, {
                                reduced: event.currentTarget.value,
                              })
                            }
                            {...(errorFor(`${row.country}:reduced`)
                              ? { error: errorFor(`${row.country}:reduced`) }
                              : {})}
                          />
                        </s-box>
                        {row.other.length > 0 ? (
                          <s-text color="subdued">
                            {row.other.join(", ")}
                          </s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {row.standardOrigin === "merchant" ||
                        row.reducedOrigin === "merchant"
                          ? "Configured by you"
                          : "Reference"}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {row.standardMapped ? (
                        <s-text color="subdued">Mapped</s-text>
                      ) : (
                        <s-link href={TAX_ROUTES.mappings}>Not mapped</s-link>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {visible.length === 0 ? (
              <s-text color="subdued">No country matches that search.</s-text>
            ) : null}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
