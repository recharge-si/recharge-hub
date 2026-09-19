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
  getTaxSettings,
  listVatRegistrations,
  replaceVatRegistrations,
  saveTaxSettings,
} from "~/adapters/db/repositories/tax.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { TAX_ROUTES } from "~/domain/tax/diagnostics";
import { countryName, isEuVatArea } from "~/domain/tax/eu";
import { formatRateKey, rateKeyFromPercent } from "~/domain/tax/rates";
import { Dropdown } from "~/web/components/dropdown";
import { LearnMore } from "~/web/components/learn-more";
import { principalFromSession } from "~/web/lib/principal.server";
import { countryOptions } from "~/web/lib/taxes";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * Registrations and policy: who the merchant is to the tax office, and what
 * this app may do when Shopify charges no tax (§20–§25 of the brief).
 *
 * Grouped sections on one contextual save bar (docs/BUILD_SPEC.md §2.6). The
 * page states facts about the merchant — a home country, a rate, an OSS
 * identification, registrations elsewhere — and never infers one: OSS is on
 * because a person ticked it.
 */
const SAVE_BAR_ID = "tax-registrations-save-bar";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const [settings, registrations] = await Promise.all([
    getTaxSettings(principal),
    listVatRegistrations(principal),
  ]);

  const domestic = registrations.find((row) => row.kind === "domestic");
  const oss = registrations.find((row) => row.kind === "oss");

  return {
    form: {
      domesticCountry: settings.domesticCountry,
      domesticRate: settings.domesticRateKey ?? "",
      domesticVatNumber: domestic?.vatNumber ?? "",
      ossEnabled: settings.ossEnabled,
      ossCountry: oss?.country ?? settings.domesticCountry,
      ossVatNumber: oss?.vatNumber ?? "",
      fallbackScope: settings.fallbackScope,
      nonEuNoTaxPolicy: settings.nonEuNoTaxPolicy,
      local: registrations
        .filter((row) => row.kind === "local")
        .map((row) => ({
          country: row.country,
          vatNumber: row.vatNumber ?? "",
          enabled: row.enabled,
        })),
    },
    configVersion: settings.configVersion,
  };
};

type Form = Awaited<ReturnType<typeof loader>>["form"];

const formSchema = z.object({
  domesticCountry: z.string().trim().length(2),
  domesticRate: z.string().trim(),
  domesticVatNumber: z.string().trim(),
  ossEnabled: z.boolean(),
  ossCountry: z.string().trim().length(2),
  ossVatNumber: z.string().trim(),
  fallbackScope: z.enum(["none", "domestic", "eu"]),
  nonEuNoTaxPolicy: z.enum(["review", "export"]),
  local: z.array(
    z.object({
      country: z.string().trim().length(2),
      vatNumber: z.string().trim(),
      enabled: z.boolean(),
    }),
  ),
});

type SaveResult =
  | { ok: true; message: string }
  | { ok: false; field?: string; message: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SaveResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const raw = String((await request.formData()).get("form") ?? "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: "The form could not be read. Reload the page and try again.",
    };
  }
  const parsed = formSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: "The form could not be read. Reload the page and try again.",
    };
  }
  const form = parsed.data;

  const domesticRateKey =
    form.domesticRate === "" ? null : rateKeyFromPercent(form.domesticRate);
  if (form.domesticRate !== "" && domesticRateKey === null) {
    return {
      ok: false,
      field: "domesticRate",
      message:
        "The home VAT rate must be a percentage between 0 and 100, for example 22.",
    };
  }

  if (form.ossEnabled && !isEuVatArea(form.ossCountry)) {
    return {
      ok: false,
      field: "ossCountry",
      message:
        "OSS is identified in an EU member state. Choose the country the OSS return is filed in.",
    };
  }

  const seen = new Set<string>();
  for (const row of form.local) {
    const country = row.country.toUpperCase();
    if (country === form.domesticCountry.toUpperCase()) {
      return {
        ok: false,
        field: "local",
        message: `${countryName(country)} is the home country. Its registration is the domestic one above, not a local registration.`,
      };
    }
    if (seen.has(country)) {
      return {
        ok: false,
        field: "local",
        message: `${countryName(country)} is listed twice. One registration per country.`,
      };
    }
    seen.add(country);
  }

  await saveTaxSettings(principal, {
    domesticCountry: form.domesticCountry.toUpperCase(),
    domesticRateKey,
    fallbackScope: form.fallbackScope,
    nonEuNoTaxPolicy: form.nonEuNoTaxPolicy,
    ossEnabled: form.ossEnabled,
  });

  await replaceVatRegistrations(principal, [
    ...(form.domesticVatNumber !== ""
      ? [
          {
            kind: "domestic" as const,
            country: form.domesticCountry.toUpperCase(),
            vatNumber: form.domesticVatNumber,
            enabled: true,
          },
        ]
      : []),
    ...(form.ossEnabled
      ? [
          {
            kind: "oss" as const,
            country: form.ossCountry.toUpperCase(),
            vatNumber: form.ossVatNumber || null,
            enabled: true,
          },
        ]
      : []),
    ...form.local.map((row) => ({
      kind: "local" as const,
      country: row.country.toUpperCase(),
      vatNumber: row.vatNumber || null,
      enabled: row.enabled,
    })),
  ]);

  await appendEvent(principal, {
    entityType: "tax_setting",
    event: "tax.settings.saved",
    detail: {
      domesticCountry: form.domesticCountry.toUpperCase(),
      domesticRateKey,
      ossEnabled: form.ossEnabled,
      fallbackScope: form.fallbackScope,
      nonEuNoTaxPolicy: form.nonEuNoTaxPolicy,
      localRegistrations: form.local.map((row) => row.country.toUpperCase()),
    },
  });

  return { ok: true, message: "Saved the tax registrations and policy." };
};

function normalise(form: Form): string {
  return JSON.stringify({
    ...form,
    domesticRate:
      rateKeyFromPercent(form.domesticRate) ?? form.domesticRate.trim(),
    local: form.local.map((row) => ({
      ...row,
      country: row.country.toUpperCase(),
    })),
  });
}

export default function TaxRegistrations() {
  const { form: saved } = useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const saving = saver.state !== "idle";
  const result = saver.data;

  const [form, setForm] = useState<Form>(saved);
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const savedKey = normalise(saved);
  const reset = useCallback(() => setForm(saved), [saved]);
  useResetWhenSaved(savedKey, reset);

  const dirty = normalise(form) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const save = () =>
    saver.submit({ form: JSON.stringify(form) }, { method: "post" });

  const countries = countryOptions();
  const euCountries = countries.filter((option) => isEuVatArea(option.value));

  return (
    <s-page heading="Registrations and policy">
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

        <s-section heading="Domestic VAT">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Where this shop is established, and the standard rate it charges
              at home. Shopify&apos;s own rate is always used when it is
              present; this rate stands in only where the policy below allows.
            </s-text>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
              gap="base"
            >
              <Dropdown
                name="domesticCountry"
                label="Home country"
                value={form.domesticCountry}
                options={countries}
                onChange={(next) => set("domesticCountry", next)}
              />
              <s-text-field
                name="domesticRate"
                label="Standard VAT rate (%)"
                details="For example 22."
                value={form.domesticRate}
                onChange={(event) =>
                  set("domesticRate", event.currentTarget.value)
                }
                {...(errorFor("domesticRate")
                  ? { error: errorFor("domesticRate") }
                  : {})}
              />
            </s-grid>
            <s-text-field
              name="domesticVatNumber"
              label="VAT number"
              details="Optional. Recorded for the audit trail; it does not change how any order is filed."
              value={form.domesticVatNumber}
              onChange={(event) =>
                set("domesticVatNumber", event.currentTarget.value)
              }
            />
          </s-stack>
        </s-section>

        <s-section heading="EU OSS">
          <s-stack direction="block" gap="base">
            <s-checkbox
              name="ossEnabled"
              value="on"
              label="Report EU consumer sales through the One Stop Shop"
              details="Tick this only if you are registered for OSS. Shopify then charges the destination country's VAT, and this app files those orders as OSS."
              checked={form.ossEnabled}
              onChange={(event) =>
                set("ossEnabled", event.currentTarget.checked)
              }
            />
            {form.ossEnabled ? (
              <s-grid
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
                gap="base"
              >
                <Dropdown
                  name="ossCountry"
                  label="Member state of identification"
                  value={form.ossCountry}
                  options={euCountries}
                  onChange={(next) => set("ossCountry", next)}
                  {...(errorFor("ossCountry")
                    ? { error: errorFor("ossCountry") }
                    : {})}
                />
                <s-text-field
                  name="ossVatNumber"
                  label="OSS identification number"
                  details="Optional."
                  value={form.ossVatNumber}
                  onChange={(event) =>
                    set("ossVatNumber", event.currentTarget.value)
                  }
                />
              </s-grid>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Registrations in other countries">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              A VAT registration in another country, inside or outside the EU.
              Orders Shopify taxes at that country&apos;s rate are then filed
              under it rather than held.
            </s-text>
            {errorFor("local") ? (
              <s-text tone="critical">{errorFor("local")}</s-text>
            ) : null}
            {form.local.map((row, index) => (
              <s-grid
                key={index}
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr auto"
                gap="base"
                alignItems="end"
              >
                <Dropdown
                  name={`local-${index}-country`}
                  label="Country"
                  value={row.country}
                  options={countries}
                  onChange={(next) =>
                    set(
                      "local",
                      form.local.map((entry, i) =>
                        i === index ? { ...entry, country: next } : entry,
                      ),
                    )
                  }
                />
                <s-text-field
                  name={`local-${index}-vat`}
                  label="VAT number"
                  value={row.vatNumber}
                  onChange={(event) =>
                    set(
                      "local",
                      form.local.map((entry, i) =>
                        i === index
                          ? { ...entry, vatNumber: event.currentTarget.value }
                          : entry,
                      ),
                    )
                  }
                />
                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() =>
                    set(
                      "local",
                      form.local.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove
                </s-button>
              </s-grid>
            ))}
            <s-stack direction="inline">
              <s-button
                variant="secondary"
                onClick={() =>
                  set("local", [
                    ...form.local,
                    { country: "DE", vatNumber: "", enabled: true },
                  ])
                }
              >
                Add registration
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="When Shopify charges no tax">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Shopify charges nothing when the store has no tax registration for
              a market. This decides what this app may do about it. Anything not
              allowed here holds the order and says why.
            </s-text>
            <Dropdown
              name="fallbackScope"
              label="Stand the home rate in"
              details={
                form.fallbackScope === "eu"
                  ? `Home orders and EU consumer orders are filed at ${form.domesticRate ? formatRateKey(rateKeyFromPercent(form.domesticRate) ?? form.domesticRate) : "the home rate"} — what a shop below the EU distance-selling threshold owes.`
                  : form.fallbackScope === "domestic"
                    ? "Only orders shipped to the home country. An EU order with no tax is held."
                    : "Never. Every line needs a rate from Shopify or an override."
              }
              value={form.fallbackScope}
              options={[
                { value: "domestic", label: "On home orders only" },
                { value: "eu", label: "On home and EU consumer orders" },
                { value: "none", label: "Never" },
              ]}
              onChange={(next) =>
                set(
                  "fallbackScope",
                  next === "eu" ? "eu" : next === "none" ? "none" : "domestic",
                )
              }
            />
            <Dropdown
              name="nonEuNoTaxPolicy"
              label="Orders outside the EU with no tax"
              details={
                form.nonEuNoTaxPolicy === "export"
                  ? "Filed as an export at 0%. Shopify charged no tax and the goods leave the EU."
                  : "Held for a person to decide, one order at a time. The safe default."
              }
              value={form.nonEuNoTaxPolicy}
              options={[
                { value: "review", label: "Hold for review" },
                { value: "export", label: "File as export at 0%" },
              ]}
              onChange={(next) =>
                set("nonEuNoTaxPolicy", next === "export" ? "export" : "review")
              }
            />
            <LearnMore label="Business buyers with a VAT number">
              <s-paragraph>
                A VAT number alone changes nothing. When Shopify charges no VAT
                to an EU business buyer whose order carries a VAT number, the
                line is filed as a reverse charge at 0%; when Shopify did charge
                VAT, that VAT is filed as it was charged.
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
