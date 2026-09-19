import { useState } from "react";

import { TAX_ROUTES } from "~/domain/tax/diagnostics";
import { countryName } from "~/domain/tax/eu";
import type {
  CustomerKind,
  TaxIssueKind,
  TaxSource,
  TaxTreatment,
} from "~/domain/tax/types";
import { formatDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import {
  CUSTOMER_KIND_LABEL,
  formatRate,
  ISSUE_LABEL,
  SOURCE_LABEL,
  TREATMENT_LABEL,
} from "~/web/lib/taxes";

/**
 * The order's VAT, as decided (§39 of the brief).
 *
 * The answer to "why did this order receive this VAT?", on the page where the
 * question is asked. One rate when the order has one; a breakdown per line
 * when it does not, because a mixed-rate order has no order-level rate and
 * inventing one would be a lie with a percent sign.
 *
 * Serialisable props: the loader builds this from the stored snapshot, and
 * nothing here re-derives a number.
 */

export interface OrderTaxLineView {
  lineId: string;
  sku: string;
  title: string;
  rateKey: string | null;
  treatment: TaxTreatment;
  source: TaxSource;
  taxableMinor: number;
  taxMinor: number;
  metakockaTaxFactor: string | null;
  mapping: "mapped" | "missing" | "not_applicable";
  overrideId: string | null;
  zeroReason: string | null;
}

export interface OrderTaxView {
  decidedAt: string;
  configVersion: number;
  /** Set once a document was written under this decision. */
  frozenAt: string | null;
  currency: string;
  taxesIncluded: boolean;
  destinationCountry: string | null;
  customerKind: CustomerKind;
  vatNumber: string | null;
  treatment: TaxTreatment | "MIXED";
  source: TaxSource | "MIXED";
  rateKeys: string[];
  totals: {
    taxableMinor: number;
    taxMinor: number;
    shopifyTaxMinor: number;
    reconciled: boolean;
  };
  ok: boolean;
  issues: {
    kind: TaxIssueKind;
    severity: "blocking" | "warning";
    message: string;
  }[];
  lines: OrderTaxLineView[];
  shipping: OrderTaxLineView | null;
  refunds: {
    refundId: string;
    createdAt: string | null;
    totals: {
      rateKey: string | null;
      treatment: TaxTreatment;
      taxableMinor: number;
      taxMinor: number;
    }[];
    totalTaxMinor: number;
  }[];
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

export function OrderTaxCard({ tax }: { tax: OrderTaxView | null }) {
  const [open, setOpen] = useState(false);

  if (!tax) {
    return (
      <s-section heading="Tax">
        <s-text color="subdued">
          Not decided yet. The next reconciliation of this order decides its VAT
          from Shopify&apos;s transaction tax and the Taxes &amp; VAT settings.
        </s-text>
      </s-section>
    );
  }

  const blocking = tax.issues.filter((issue) => issue.severity === "blocking");
  const warnings = tax.issues.filter((issue) => issue.severity === "warning");
  const all = tax.shipping ? [...tax.lines, tax.shipping] : tax.lines;
  const singleRate = tax.rateKeys.length === 1 && tax.treatment !== "MIXED";
  const override = all.find((line) => line.overrideId !== null);
  const total = tax.totals.taxableMinor + tax.totals.taxMinor;

  return (
    <s-section heading="Tax">
      <s-stack direction="block" gap="base">
        {blocking.length > 0 ? (
          <s-banner tone="critical" heading="VAT could not be filed safely">
            <s-stack direction="block" gap="small-300">
              {blocking.map((issue) => (
                <s-paragraph key={`${issue.kind}:${issue.message}`}>
                  {issue.message}
                </s-paragraph>
              ))}
            </s-stack>
            <s-link slot="primary-action" href={TAX_ROUTES.overview}>
              Open Taxes &amp; VAT
            </s-link>
          </s-banner>
        ) : null}

        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr 1fr, 1fr 1fr 1fr 1fr"
          gap="base"
        >
          <Fact
            label="Destination"
            value={
              tax.destinationCountry
                ? countryName(tax.destinationCountry)
                : "Unknown"
            }
          />
          <Fact
            label="Customer"
            value={
              tax.vatNumber
                ? `${CUSTOMER_KIND_LABEL[tax.customerKind]}, VAT ${tax.vatNumber}`
                : CUSTOMER_KIND_LABEL[tax.customerKind]
            }
          />
          <Fact label="Treatment" value={TREATMENT_LABEL[tax.treatment]} />
          <Fact label="Source" value={SOURCE_LABEL[tax.source]} />
        </s-grid>

        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr 1fr, 1fr 1fr 1fr 1fr"
          gap="base"
        >
          <Fact
            label="Taxable amount"
            value={formatMoney(tax.totals.taxableMinor, tax.currency)}
          />
          <Fact
            label="VAT"
            value={formatMoney(tax.totals.taxMinor, tax.currency)}
          />
          <Fact label="Total" value={formatMoney(total, tax.currency)} />
          {singleRate ? (
            <Fact
              label="Rate"
              value={`${formatRate(tax.rateKeys[0] ?? null)}${
                all[0]?.metakockaTaxFactor
                  ? `, MetaKocka ${all[0].metakockaTaxFactor}`
                  : ""
              }`}
            />
          ) : (
            <Fact
              label="Rates"
              value={
                tax.rateKeys.length === 0
                  ? "—"
                  : tax.rateKeys.map(formatRate).join(", ")
              }
            />
          )}
        </s-grid>

        {override ? (
          <s-text color="subdued">
            {`An override applies to ${all.filter((line) => line.overrideId).length === all.length ? "every line" : "some lines"} of this order. ${override.zeroReason ?? ""}`.trim()}
          </s-text>
        ) : null}

        {warnings.map((issue) => (
          <s-text key={`${issue.kind}:${issue.message}`} color="subdued">
            {`${ISSUE_LABEL[issue.kind]}: ${issue.message}`}
          </s-text>
        ))}

        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            type="button"
            variant="secondary"
            icon={open ? "chevron-up" : "chevron-down"}
            onClick={() => setOpen((now) => !now)}
          >
            {open ? "Hide tax details" : "View tax details"}
          </s-button>
          <s-text color="subdued">
            {`Decided ${formatDateTime(tax.decidedAt)} under configuration ${tax.configVersion}${tax.frozenAt ? ", kept as filed" : ""}. Prices ${tax.taxesIncluded ? "include" : "exclude"} tax.`}
          </s-text>
        </s-stack>

        {open ? (
          <s-stack direction="block" gap="base">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Line</s-table-header>
                <s-table-header listSlot="labeled">Rate</s-table-header>
                <s-table-header listSlot="labeled">Treatment</s-table-header>
                <s-table-header listSlot="labeled">Source</s-table-header>
                <s-table-header listSlot="labeled">Taxable</s-table-header>
                <s-table-header listSlot="labeled">VAT</s-table-header>
                <s-table-header listSlot="labeled">MetaKocka</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {all.map((line) => (
                  <s-table-row key={line.lineId}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">
                          {line.lineId === "shipping" ? "Shipping" : line.title}
                        </s-text>
                        {line.sku ? (
                          <s-text color="subdued">{line.sku}</s-text>
                        ) : null}
                        {line.zeroReason ? (
                          <s-text color="subdued">{line.zeroReason}</s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{formatRate(line.rateKey)}</s-table-cell>
                    <s-table-cell>
                      {TREATMENT_LABEL[line.treatment]}
                    </s-table-cell>
                    <s-table-cell>{SOURCE_LABEL[line.source]}</s-table-cell>
                    <s-table-cell>
                      {formatMoney(line.taxableMinor, tax.currency)}
                    </s-table-cell>
                    <s-table-cell>
                      {formatMoney(line.taxMinor, tax.currency)}
                    </s-table-cell>
                    <s-table-cell>
                      {line.mapping === "mapped" ? (
                        <s-text color="subdued">{`tax_factor ${line.metakockaTaxFactor}`}</s-text>
                      ) : line.mapping === "missing" ? (
                        <s-link href={TAX_ROUTES.mappings}>Not mapped</s-link>
                      ) : (
                        <s-text color="subdued">—</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <s-text color="subdued">
              {tax.totals.reconciled
                ? `Shopify reports ${formatMoney(tax.totals.shopifyTaxMinor, tax.currency)} tax on the order.`
                : `Shopify reports ${formatMoney(tax.totals.shopifyTaxMinor, tax.currency)} tax on the order; the lines add up to ${formatMoney(tax.totals.taxMinor, tax.currency)}.`}
            </s-text>

            {tax.refunds.length > 0 ? (
              <s-stack direction="block" gap="small-300">
                <s-text type="strong">Refunded tax to reverse</s-text>
                {tax.refunds.map((refund) => (
                  <s-text key={refund.refundId} color="subdued">
                    {`Refund ${refund.refundId}${refund.createdAt ? `, ${formatDateTime(refund.createdAt)}` : ""}: ${refund.totals
                      .map(
                        (entry) =>
                          `${formatMoney(entry.taxMinor, tax.currency)} at ${formatRate(entry.rateKey)} (${TREATMENT_LABEL[entry.treatment]})`,
                      )
                      .join(
                        ", ",
                      )}. Reverses the treatment this order was filed under, not today's settings.`}
                  </s-text>
                ))}
              </s-stack>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}
