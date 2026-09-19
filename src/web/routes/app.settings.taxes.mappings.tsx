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
import { listTaxRates } from "~/adapters/db/repositories/pricelist.server";
import {
  getTaxDiagnosticsFacts,
  replaceTaxMappings,
} from "~/adapters/db/repositories/tax.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { ratesFor } from "~/domain/tax/config";
import { requiredRates, TAX_ROUTES } from "~/domain/tax/diagnostics";
import { countryName } from "~/domain/tax/eu";
import {
  factorToPpm,
  formatRateKey,
  ppmToFactor,
  rateKeyFromPercent,
  rateKeyToFactor,
  rateKeyToPpm,
  sameRate,
} from "~/domain/tax/rates";
import { principalFromSession } from "~/web/lib/principal.server";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * MetaKocka mappings: one row per VAT rate, the `tax_factor` MetaKocka is sent
 * for it (§35, §36 of the brief).
 *
 * §3 verified two things that make this page exist: MetaKocka will not infer
 * a line's tax, and it accepts a wrong factor without a word. So a rate is
 * only ever sent once a person has confirmed what it maps to. The rows are
 * every rate that matters — the home rate, 0%, the rates recent orders used,
 * the rates of the home country's table, anything already mapped — and a
 * missing one is the loudest thing on the page.
 *
 * The factor defaults to the rate itself (22% → 0.22) because that is what
 * it almost always is; it stays editable because a company's register may
 * carry a rate under a slightly different factor, and that is theirs to say.
 */
const SAVE_BAR_ID = "tax-mappings-save-bar";

interface Row {
  rateKey: string;
  factor: string;
  enabled: boolean;
  /** Why the row is here, in the merchant's words. Empty for a rate only they added. */
  because: string[];
  orders: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [facts, metakockaRates] = await Promise.all([
    getTaxDiagnosticsFacts(principal, new Date()),
    listTaxRates(principal),
  ]);
  const { config } = facts;

  const because = new Map<string, Set<string>>();
  const orders = new Map<string, number>();
  const note = (rateKey: string, why: string) => {
    const set = because.get(rateKey) ?? new Set<string>();
    set.add(why);
    because.set(rateKey, set);
  };

  for (const rateKey of requiredRates(config)) {
    note(
      rateKey,
      rateKey === "0"
        ? "Non-taxable lines, exports and reverse charges"
        : sameRate(rateKey, config.domesticRateKey)
          ? "Home rate"
          : "Used by an override",
    );
  }
  for (const row of ratesFor(config, config.domesticCountry)) {
    note(row.rateKey, `${countryName(config.domesticCountry)} ${row.kind.replace("_", " ")} rate`);
  }
  for (const row of facts.observed) {
    note(row.rateKey, `Used by ${row.orders} recent ${row.orders === 1 ? "order" : "orders"}`);
    orders.set(row.rateKey, row.orders);
  }
  for (const mapping of config.mappings) note(mapping.rateKey, "Mapped");

  const rows: Row[] = [...because.entries()]
    .map(([rateKey, why]) => {
      const mapping = config.mappings.find((row) => sameRate(row.rateKey, rateKey));
      return {
        rateKey,
        factor: mapping?.metakockaTaxFactor ?? "",
        enabled: mapping?.enabled ?? false,
        because: [...why].filter((entry) => entry !== "Mapped"),
        orders: orders.get(rateKey) ?? 0,
      };
    })
    .sort((a, b) => (rateKeyToPpm(a.rateKey) ?? 0) - (rateKeyToPpm(b.rateKey) ?? 0));

  return {
    rows,
    // Already sorted numerically by the repository; canonicalised for display.
    metakockaRates: metakockaRates
      .map((rate) => rateKeyFromPercent(rate))
      .filter((rate): rate is string => rate !== null),
  };
};

const formSchema = z.array(
  z.object({
    rateKey: z.string().trim(),
    factor: z.string().trim(),
    enabled: z.boolean(),
  }),
);

type SaveResult =
  | { ok: true; message: string }
  | { ok: false; field?: string; message: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<SaveResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  let json: unknown;
  try {
    json = JSON.parse(String((await request.formData()).get("rows") ?? ""));
  } catch {
    return { ok: false, message: "The mappings could not be read. Reload the page and try again." };
  }
  const parsed = formSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, message: "The mappings could not be read. Reload the page and try again." };
  }

  const mappings: { rateKey: string; metakockaTaxFactor: string; enabled: boolean }[] = [];
  for (const row of parsed.data) {
    const rateKey = rateKeyFromPercent(row.rateKey);
    if (rateKey === null) {
      return {
        ok: false,
        field: row.rateKey,
        message: `"${row.rateKey}" is not a VAT rate. Enter a percentage between 0 and 100, for example 9.5.`,
      };
    }
    // An empty factor means "not mapped": the absence of a row.
    if (row.factor === "") continue;

    const ppm = factorToPpm(row.factor);
    if (ppm === null) {
      return {
        ok: false,
        field: rateKey,
        message: `The MetaKocka tax factor for ${formatRateKey(rateKey)} must be a decimal between 0 and 1, for example ${rateKeyToFactor(rateKey) ?? "0.22"}.`,
      };
    }
    if (mappings.some((entry) => sameRate(entry.rateKey, rateKey))) {
      return {
        ok: false,
        field: rateKey,
        message: `${formatRateKey(rateKey)} is listed twice. One mapping per rate.`,
      };
    }
    mappings.push({ rateKey, metakockaTaxFactor: ppmToFactor(ppm), enabled: row.enabled });
  }

  await replaceTaxMappings(principal, mappings);
  await appendEvent(principal, {
    entityType: "tax_mapping",
    event: "tax.mappings.saved",
    detail: {
      mappings: mappings.map((row) => `${row.rateKey}→${row.metakockaTaxFactor}${row.enabled ? "" : " (off)"}`),
    },
  });

  return {
    ok: true,
    message: `Saved ${mappings.length} VAT rate ${mappings.length === 1 ? "mapping" : "mappings"}.`,
  };
};

function normalise(rows: Row[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        rateKey: rateKeyFromPercent(row.rateKey) ?? row.rateKey,
        factor: row.factor === "" ? "" : (factorToPpm(row.factor) ?? row.factor),
        enabled: row.enabled,
      }))
      .filter((row) => row.factor !== "")
      .sort((a, b) => a.rateKey.localeCompare(b.rateKey)),
  );
}

export default function TaxMappings() {
  const { rows: saved, metakockaRates } = useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const saving = saver.state !== "idle";
  const result = saver.data;

  const [rows, setRows] = useState<Row[]>(saved);
  const [newRate, setNewRate] = useState("");

  const savedKey = normalise(saved);
  const reset = useCallback(() => setRows(saved), [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(rows) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const update = (rateKey: string, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.rateKey === rateKey ? { ...row, ...patch } : row)),
    );

  const addRate = () => {
    const rateKey = rateKeyFromPercent(newRate);
    if (rateKey === null || rows.some((row) => sameRate(row.rateKey, rateKey))) return;
    setRows((current) =>
      [
        ...current,
        {
          rateKey,
          factor: rateKeyToFactor(rateKey) ?? "",
          enabled: true,
          because: [],
          orders: 0,
        },
      ].sort((a, b) => (rateKeyToPpm(a.rateKey) ?? 0) - (rateKeyToPpm(b.rateKey) ?? 0)),
    );
    setNewRate("");
  };

  const save = () =>
    saver.submit(
      {
        rows: JSON.stringify(
          rows.map(({ rateKey, factor, enabled }) => ({ rateKey, factor, enabled })),
        ),
      },
      { method: "post" },
    );

  const unmapped = rows.filter((row) => row.factor === "" || !row.enabled);
  const errorFor = (rateKey: string) =>
    result && !result.ok && result.field === rateKey ? result.message : undefined;

  return (
    <s-page heading="MetaKocka mappings">
      <s-link slot="breadcrumb-actions" href={TAX_ROUTES.overview}>
        Taxes & VAT
      </s-link>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button variant="primary" onClick={save} {...(saving ? { loading: "" } : {})}>
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

        {unmapped.length > 0 ? (
          <s-banner
            tone="warning"
            heading={`${unmapped.length} ${unmapped.length === 1 ? "rate has" : "rates have"} no MetaKocka mapping`}
          >
            <s-paragraph>
              An order using {unmapped.length === 1 ? "it" : "any of them"} is held until it is mapped. Nothing is
              sent with a guessed factor.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="VAT rates">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Each VAT rate an order uses becomes one MetaKocka tax factor. The
              factor is the rate as a decimal — 22% is 0.22 — unless your
              company&apos;s register says otherwise.
            </s-paragraph>

            {metakockaRates.length > 0 ? (
              <s-text color="subdued">
                {`Rates your MetaKocka pricelists carry: ${metakockaRates.map((rate) => `${rate}%`).join(", ")}.`}
              </s-text>
            ) : null}

            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">VAT rate</s-table-header>
                <s-table-header listSlot="labeled">Why it is here</s-table-header>
                <s-table-header listSlot="labeled">MetaKocka tax factor</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => {
                  const mapped = row.factor !== "" && row.enabled;
                  return (
                    <s-table-row key={row.rateKey}>
                      <s-table-cell>
                        <s-text type="strong">{formatRateKey(row.rateKey)}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">
                          {row.because.length > 0 ? row.because.join(". ") : "Added by you"}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-box maxInlineSize="200px">
                          <s-text-field
                            name={`factor-${row.rateKey}`}
                            label={`MetaKocka tax factor for ${formatRateKey(row.rateKey)}`}
                            labelAccessibilityVisibility="exclusive"
                            placeholder={rateKeyToFactor(row.rateKey) ?? ""}
                            value={row.factor}
                            onChange={(event) =>
                              update(row.rateKey, {
                                factor: event.currentTarget.value,
                                enabled: true,
                              })
                            }
                            {...(errorFor(row.rateKey) ? { error: errorFor(row.rateKey) } : {})}
                          />
                        </s-box>
                      </s-table-cell>
                      <s-table-cell>
                        {mapped ? (
                          <s-text color="subdued">Mapped</s-text>
                        ) : (
                          <s-stack direction="inline" gap="small-300" alignItems="center">
                            <s-badge tone="critical">Not configured</s-badge>
                            {row.factor === "" ? (
                              <s-button
                                variant="tertiary"
                                onClick={() =>
                                  update(row.rateKey, {
                                    factor: rateKeyToFactor(row.rateKey) ?? "",
                                    enabled: true,
                                  })
                                }
                              >
                                {`Map as ${rateKeyToFactor(row.rateKey) ?? ""}`}
                              </s-button>
                            ) : null}
                          </s-stack>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>

            <s-grid
              gridTemplateColumns="@container (inline-size <= 500px) 1fr, 220px auto"
              gap="base"
              alignItems="end"
            >
              <s-text-field
                name="newRate"
                label="Add a rate (%)"
                details="For a rate no order has used yet, for example 5."
                value={newRate}
                onChange={(event) => setNewRate(event.currentTarget.value)}
              />
              <s-button variant="secondary" onClick={addRate}>
                Add rate
              </s-button>
            </s-grid>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
