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
  getTaxConfig,
  replaceTaxOverrides,
} from "~/adapters/db/repositories/tax.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { mappingFor } from "~/domain/tax/config";
import { TAX_ROUTES } from "~/domain/tax/diagnostics";
import { countryName } from "~/domain/tax/eu";
import { formatRateKey, rateKeyFromPercent } from "~/domain/tax/rates";
import { TAX_TREATMENTS, type TaxTreatment } from "~/domain/tax/types";
import { Dropdown } from "~/web/components/dropdown";
import { principalFromSession } from "~/web/lib/principal.server";
import { countryOptions, OVERRIDE_TREATMENTS } from "~/web/lib/taxes";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * Overrides: deliberate exceptions to what the engine would decide (§37 of
 * the brief).
 *
 * Each one is intentional (a person wrote it, with a reason), visible (every
 * order it touches names it), validated (server side, against the mappings)
 * and precedence-aware: a SKU override outranks a country one, and either
 * outranks Shopify's rate only when it sets a rate. An override that sets
 * only a treatment answers a question the engine could not — what an
 * unexplained 0% to a given country means — and changes no amount.
 */
const SAVE_BAR_ID = "tax-overrides-save-bar";

interface Row {
  key: string;
  scope: "country" | "sku";
  match: string;
  treatment: string;
  rate: string;
  reason: string;
  enabled: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const config = await getTaxConfig(principal);

  return {
    rows: config.overrides.map((row): Row => ({
      key: row.id,
      scope: row.scope,
      match: row.match,
      treatment: row.treatment ?? "",
      rate: row.rateKey ?? "",
      reason: row.reason,
      enabled: row.enabled,
    })),
    unmappedRates: config.overrides
      .map((row) => row.rateKey)
      .filter(
        (rate): rate is string =>
          rate !== null && mappingFor(config, rate) === null,
      ),
  };
};

const formSchema = z.array(
  z.object({
    scope: z.enum(["country", "sku"]),
    match: z.string().trim(),
    treatment: z.string().trim(),
    rate: z.string().trim(),
    reason: z.string().trim(),
    enabled: z.boolean(),
  }),
);

type SaveResult =
  | { ok: true; message: string }
  | { ok: false; field?: string; message: string };

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
      message:
        "The overrides could not be read. Reload the page and try again.",
    };
  }
  const parsed = formSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        "The overrides could not be read. Reload the page and try again.",
    };
  }

  const config = await getTaxConfig(principal);
  const overrides: {
    scope: "country" | "sku";
    match: string;
    treatment: TaxTreatment | null;
    rateKey: string | null;
    reason: string;
    enabled: boolean;
  }[] = [];

  for (const [index, row] of parsed.data.entries()) {
    const field = `row-${index}`;
    if (row.match === "") {
      return {
        ok: false,
        field,
        message:
          row.scope === "country"
            ? "Choose a country."
            : "Enter the SKU the override applies to.",
      };
    }
    if (row.reason === "") {
      return {
        ok: false,
        field,
        message:
          "Give the reason for this override. It is recorded on every order it touches.",
      };
    }

    const treatment =
      row.treatment === ""
        ? null
        : (TAX_TREATMENTS.find((entry) => entry === row.treatment) ?? null);
    if (row.treatment !== "" && treatment === null) {
      return { ok: false, field, message: "Choose a treatment from the list." };
    }

    const rateKey = row.rate === "" ? null : rateKeyFromPercent(row.rate);
    if (row.rate !== "" && rateKey === null) {
      return {
        ok: false,
        field,
        message:
          "The rate must be a percentage between 0 and 100, for example 9.5, or left empty to keep Shopify's rate.",
      };
    }
    if (treatment === null && rateKey === null) {
      return {
        ok: false,
        field,
        message:
          "An override sets a treatment, a rate, or both. This one sets neither.",
      };
    }
    if (rateKey !== null && mappingFor(config, rateKey) === null) {
      return {
        ok: false,
        field,
        message: `${formatRateKey(rateKey)} has no MetaKocka mapping, so an override to it would hold every order it touches. Map the rate first.`,
      };
    }

    const match = row.scope === "country" ? row.match.toUpperCase() : row.match;
    if (
      overrides.some(
        (entry) => entry.scope === row.scope && entry.match === match,
      )
    ) {
      return {
        ok: false,
        field,
        message: `There is already an override for ${row.scope === "country" ? countryName(match) : match}. One per country or SKU.`,
      };
    }

    overrides.push({
      scope: row.scope,
      match,
      treatment,
      rateKey,
      reason: row.reason,
      enabled: row.enabled,
    });
  }

  await replaceTaxOverrides(principal, overrides);
  await appendEvent(principal, {
    entityType: "tax_override",
    event: "tax.overrides.saved",
    detail: {
      overrides: overrides.map(
        (row) =>
          `${row.scope}:${row.match} → ${row.treatment ?? "-"} ${row.rateKey ?? ""}${row.enabled ? "" : " (off)"}`,
      ),
    },
  });

  return {
    ok: true,
    message: `Saved ${overrides.length} ${overrides.length === 1 ? "override" : "overrides"}.`,
  };
};

function normalise(rows: Row[]): string {
  return JSON.stringify(
    rows.map(({ scope, match, treatment, rate, reason, enabled }) => ({
      scope,
      match: scope === "country" ? match.toUpperCase() : match.trim(),
      treatment,
      rate: rateKeyFromPercent(rate) ?? rate.trim(),
      reason: reason.trim(),
      enabled,
    })),
  );
}

let nextKey = 0;

export default function TaxOverrides() {
  const { rows: saved, unmappedRates } = useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const saving = saver.state !== "idle";
  const result = saver.data;

  const [rows, setRows] = useState<Row[]>(saved);

  const savedKey = normalise(saved);
  const reset = useCallback(() => setRows(saved), [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(rows) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );

  const add = () => {
    nextKey += 1;
    setRows((current) => [
      ...current,
      {
        key: `new-${nextKey}`,
        scope: "country",
        match: "CH",
        treatment: "NON_EU_EXPORT",
        rate: "",
        reason: "",
        enabled: true,
      },
    ]);
  };

  const save = () =>
    saver.submit(
      {
        rows: JSON.stringify(
          rows.map(({ scope, match, treatment, rate, reason, enabled }) => ({
            scope,
            match,
            treatment,
            rate,
            reason,
            enabled,
          })),
        ),
      },
      { method: "post" },
    );

  const errorFor = (index: number) =>
    result && !result.ok && result.field === `row-${index}`
      ? result.message
      : undefined;

  const countries = countryOptions();
  const treatments = [
    { value: "", label: "Keep the decided treatment" },
    ...OVERRIDE_TREATMENTS,
  ];

  return (
    <s-page heading="Overrides">
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

        {unmappedRates.length > 0 ? (
          <s-banner
            tone="warning"
            heading="An override points at an unmapped rate"
          >
            <s-paragraph>
              {`${unmappedRates.map(formatRateKey).join(", ")} ${unmappedRates.length === 1 ? "has" : "have"} no MetaKocka mapping, so every order the override touches is held.`}
            </s-paragraph>
            <s-link slot="primary-action" href={TAX_ROUTES.mappings}>
              Configure mapping
            </s-link>
          </s-banner>
        ) : null}

        <s-section heading="Overrides">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              An override answers a question the automatic decision could not,
              or states a rate Shopify does not know about. A SKU override
              outranks a country one. Every order an override touches says so.
            </s-paragraph>
            <s-text color="subdued">
              Setting a treatment alone changes no amount; it records what kind
              of VAT event the order is. Setting a rate replaces Shopify&apos;s
              rate for those lines and recomputes the tax on them.
            </s-text>

            {rows.length === 0 ? (
              <s-text color="subdued">
                No overrides. Shopify&apos;s tax and the policy decide every
                order.
              </s-text>
            ) : null}

            {rows.map((row, index) => (
              <s-box
                key={row.key}
                padding="base"
                borderRadius="base"
                borderWidth="base"
                borderStyle="solid"
                borderColor="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 640px) 1fr, 160px 1fr auto"
                    gap="base"
                    alignItems="end"
                  >
                    <Dropdown
                      name={`scope-${row.key}`}
                      label="Applies to"
                      value={row.scope}
                      options={[
                        { value: "country", label: "A country" },
                        { value: "sku", label: "A SKU" },
                      ]}
                      onChange={(next) =>
                        update(row.key, {
                          scope: next === "sku" ? "sku" : "country",
                          match: next === "sku" ? "" : "CH",
                        })
                      }
                    />
                    {row.scope === "country" ? (
                      <Dropdown
                        name={`match-${row.key}`}
                        label="Country"
                        value={row.match}
                        options={countries}
                        onChange={(next) => update(row.key, { match: next })}
                      />
                    ) : (
                      <s-text-field
                        name={`match-${row.key}`}
                        label="SKU"
                        value={row.match}
                        onChange={(event) =>
                          update(row.key, { match: event.currentTarget.value })
                        }
                      />
                    )}
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() =>
                        setRows((current) =>
                          current.filter((entry) => entry.key !== row.key),
                        )
                      }
                    >
                      Remove
                    </s-button>
                  </s-grid>

                  <s-grid
                    gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 160px"
                    gap="base"
                    alignItems="end"
                  >
                    <Dropdown
                      name={`treatment-${row.key}`}
                      label="Treatment"
                      value={row.treatment}
                      options={treatments}
                      onChange={(next) => update(row.key, { treatment: next })}
                    />
                    <s-text-field
                      name={`rate-${row.key}`}
                      label="Rate (%)"
                      details="Empty keeps Shopify's rate."
                      value={row.rate}
                      onChange={(event) =>
                        update(row.key, { rate: event.currentTarget.value })
                      }
                    />
                  </s-grid>

                  <s-text-field
                    name={`reason-${row.key}`}
                    label="Reason"
                    details="Recorded on every order this override touches."
                    value={row.reason}
                    onChange={(event) =>
                      update(row.key, { reason: event.currentTarget.value })
                    }
                    {...(errorFor(index) ? { error: errorFor(index) } : {})}
                  />

                  <s-checkbox
                    name={`enabled-${row.key}`}
                    value="on"
                    label="Enabled"
                    checked={row.enabled}
                    onChange={(event) =>
                      update(row.key, { enabled: event.currentTarget.checked })
                    }
                  />
                </s-stack>
              </s-box>
            ))}

            <s-stack direction="inline">
              <s-button variant="secondary" onClick={add}>
                Add override
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
