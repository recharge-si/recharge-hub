import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getTaxDiagnosticsFacts } from "~/adapters/db/repositories/tax.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  computeTaxDiagnostics,
  TAX_ROUTES,
  type TaxCheck,
} from "~/domain/tax/diagnostics";
import { countryName } from "~/domain/tax/eu";
import { formatRateKey } from "~/domain/tax/rates";
import { formatDateTime } from "~/web/lib/datetime";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Taxes & VAT: what is configured, what the orders have used, and what
 * stands between the two (§20, §38 of the brief).
 *
 * The first screen is deliberately simple — five lines a merchant can read
 * in ten seconds, each with the one button that changes it. The accountant's
 * detail (country tables, mappings, overrides) is a page each, behind
 * Configure. Everything here is read from our own tables; nothing waits on
 * MetaKocka (docs/BUILD_SPEC.md §2.5).
 *
 * Healthy is calm (docs/ui-conventions.md): a check with nothing wrong is a
 * neutral sentence, and the one that needs a person is the loudest thing on
 * the page and the only one with a coloured badge.
 */
const HELP_MODAL_ID = "taxes-help";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const facts = await getTaxDiagnosticsFacts(principal, new Date());
  const diagnostics = computeTaxDiagnostics(facts);

  return {
    diagnostics,
    observed: facts.observed
      .map((row) => ({
        rateKey: row.rateKey,
        orders: row.orders,
        countries: row.countries,
        lastSeenAt: row.lastSeenAt,
        mapped: !diagnostics.unmappedRates.includes(row.rateKey),
      }))
      .sort((a, b) => b.orders - a.orders),
    decidedOrders: facts.decidedOrders,
    home: {
      country: countryName(facts.config.domesticCountry),
      rate: facts.config.domesticRateKey,
    },
  };
};

const TONE: Record<TaxCheck["status"], "neutral" | "warning" | "critical"> = {
  ok: "neutral",
  warning: "warning",
  attention: "critical",
};

const LABEL: Record<TaxCheck["status"], string> = {
  ok: "Ready",
  warning: "Worth a look",
  attention: "Needs attention",
};

interface ConfigureLink {
  title: string;
  description: string;
  href: string;
}

const LINKS: ConfigureLink[] = [
  {
    title: "Registrations and policy",
    description:
      "Home country and rate, EU OSS, registrations elsewhere, and what to do when Shopify charges no tax.",
    href: TAX_ROUTES.registrations,
  },
  {
    title: "EU VAT rates",
    description:
      "The rates expected per country, used to check what Shopify charged. Never what an order is filed with.",
    href: TAX_ROUTES.rates,
  },
  {
    title: "MetaKocka mappings",
    description:
      "Which tax factor MetaKocka is sent for each VAT rate an order uses.",
    href: TAX_ROUTES.mappings,
  },
  {
    title: "Overrides",
    description:
      "Deliberate exceptions by country or SKU, each with a reason, visible on every order they touch.",
    href: TAX_ROUTES.overrides,
  },
];

export default function Taxes() {
  const { diagnostics, observed, decidedOrders, home } =
    useLoaderData<typeof loader>();

  const attention = diagnostics.checks.filter(
    (check) => check.status === "attention",
  );

  return (
    <s-page heading="Taxes & VAT">
      <s-link slot="breadcrumb-actions" href="/app/settings">
        Settings
      </s-link>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About taxes">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shopify works out the tax on every order. This app reads that tax,
            works out what kind of VAT event each line is — home VAT, OSS,
            reverse charge, export — checks it against what you have configured
            here, and sends MetaKocka the matching tax factor.
          </s-paragraph>
          <s-paragraph>
            Nothing here changes what a customer is charged, and this app does
            not decide your tax obligations. When it cannot say how a line
            should be filed, the order waits and tells you what to change.
          </s-paragraph>
          <s-paragraph>
            Every order keeps a record of the decision it was filed under, so a
            refund months later reverses the same rate and treatment whatever
            the settings say by then.
          </s-paragraph>
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

      <s-stack direction="block" gap="large">
        {attention.length > 0 ? (
          <s-banner
            tone="warning"
            heading={
              diagnostics.blockedOrders > 0
                ? `${diagnostics.blockedOrders} ${diagnostics.blockedOrders === 1 ? "order is" : "orders are"} held until VAT can be filed safely`
                : "Tax configuration needs attention"
            }
          >
            <s-paragraph>
              {attention
                .map((check) => check.reason)
                .filter(Boolean)
                .join(" ")}
            </s-paragraph>
            {attention[0]?.action ? (
              <s-link slot="primary-action" href={attention[0].action.href}>
                {attention[0].action.label}
              </s-link>
            ) : null}
          </s-banner>
        ) : null}

        <s-section heading="Overview">
          <s-stack direction="block" gap="base">
            {diagnostics.checks.map((check) => (
              <s-stack key={check.key} direction="block" gap="small-400">
                <s-grid
                  gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{check.title}</s-text>
                    <s-text color="subdued">{check.summary}</s-text>
                  </s-stack>
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    {check.status !== "ok" ? (
                      <s-badge tone={TONE[check.status]}>
                        {LABEL[check.status]}
                      </s-badge>
                    ) : null}
                    {check.action ? (
                      <s-button
                        variant={
                          check.status === "attention" ? "primary" : "tertiary"
                        }
                        href={check.action.href}
                      >
                        {check.action.label}
                      </s-button>
                    ) : null}
                  </s-stack>
                </s-grid>
                {check.reason ? (
                  <s-text
                    color="subdued"
                    tone={check.status === "attention" ? "critical" : "auto"}
                  >
                    {check.reason}
                  </s-text>
                ) : null}
              </s-stack>
            ))}
          </s-stack>
        </s-section>

        <s-section heading="Rates in use">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {decidedOrders === 0
                ? "No orders have been decided yet. Rates appear here as orders arrive."
                : `From the last ${decidedOrders} ${decidedOrders === 1 ? "order" : "orders"} decided. A rate with no mapping holds every order that uses it.`}
            </s-text>

            {observed.length > 0 ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Rate</s-table-header>
                  <s-table-header listSlot="labeled">Orders</s-table-header>
                  <s-table-header listSlot="labeled">
                    Destinations
                  </s-table-header>
                  <s-table-header listSlot="labeled">Last seen</s-table-header>
                  <s-table-header listSlot="labeled">
                    MetaKocka mapping
                  </s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {observed.map((row) => (
                    <s-table-row key={row.rateKey}>
                      <s-table-cell>
                        <s-text type="strong">
                          {formatRateKey(row.rateKey)}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>{row.orders}</s-table-cell>
                      <s-table-cell>
                        {row.countries.length > 0
                          ? row.countries.map(countryName).join(", ")
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        {row.lastSeenAt ? formatDateTime(row.lastSeenAt) : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        {row.mapped ? (
                          <s-text color="subdued">Mapped</s-text>
                        ) : (
                          <s-stack
                            direction="inline"
                            gap="small-300"
                            alignItems="center"
                          >
                            <s-badge tone="critical">Not mapped</s-badge>
                            <s-link href={TAX_ROUTES.mappings}>
                              Configure mapping
                            </s-link>
                          </s-stack>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Configure">
          <s-stack direction="block" gap="base">
            {LINKS.map((link) => (
              <s-stack key={link.href} direction="block" gap="small-500">
                <s-link href={link.href}>{link.title}</s-link>
                <s-text color="subdued">{link.description}</s-text>
              </s-stack>
            ))}
          </s-stack>
        </s-section>

        <s-section heading="This shop">
          <s-text color="subdued">
            {home.rate
              ? `Home country ${home.country}, standard VAT ${formatRateKey(home.rate)}. Shopify's transaction tax is always used when it is present; the home rate only stands in where the fallback setting allows.`
              : `Home country ${home.country}. No home rate is set yet.`}
          </s-text>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
