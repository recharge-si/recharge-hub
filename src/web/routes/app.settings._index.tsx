import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { READINESS_ROUTES } from "~/domain/readiness";
import { ReadinessList } from "~/web/components/readiness-list";
import { SetupBanner } from "~/web/components/setup-banner";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Where everything is configured, and what state it is in.
 *
 * The app used to put four settings pages in the primary navigation beside the
 * pages a merchant works in, which made the nav a list of tables rather than a
 * list of jobs. Each of those pages now lives with the thing it configures, and
 * this is the one place that knows where they all are.
 *
 * Everything is read from our own database (docs/BUILD_SPEC.md section 2.5).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const readiness = await getReadiness(principal);

  return {
    shopDomain: session.shop,
    components: readiness.components,
    overall: readiness.overall,
    activated: readiness.activated,
  };
};

interface SettingsLink {
  title: string;
  description: string;
  href: string;
}

const LINKS: SettingsLink[] = [
  {
    title: "MetaKocka connection",
    description:
      "Company ID, secret key, API user email and the stock webhook. Store owner only.",
    href: READINESS_ROUTES.connection,
  },
  {
    title: "Order settings",
    description:
      "How a Shopify order becomes a MetaKocka sales order, and what happens to it afterwards.",
    href: READINESS_ROUTES.orders,
  },
  {
    title: "Payment types",
    description:
      "Which MetaKocka payment type each Shopify payment method settles into.",
    href: READINESS_ROUTES.payments,
  },
  {
    title: "Taxes & VAT",
    description:
      "Home VAT, EU OSS, registrations, the rates expected per country, and which MetaKocka tax factor each rate becomes.",
    href: READINESS_ROUTES.taxes,
  },
  {
    title: "Locations",
    description:
      "Which MetaKocka warehouse each Shopify location means, and which way stock is copied.",
    href: READINESS_ROUTES.locations,
  },
  {
    title: "Product sync",
    description:
      "Matching the two catalogues by SKU, and the optional writes into the MetaKocka catalogue.",
    href: "/app/products/sync",
  },
];

export default function Settings() {
  const { shopDomain, components, overall, activated } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        <s-section heading="Setup">
          <s-stack direction="block" gap="base">
            {!activated ? (
              <SetupBanner components={components} overall={overall} />
            ) : overall === "needs_attention" ? (
              <s-banner tone="warning" heading="Some settings need attention">
                <s-paragraph>
                  Synchronization is running, but part of it cannot do its job
                  until these are answered.
                </s-paragraph>
              </s-banner>
            ) : null}

            <ReadinessList components={components} />

            {activated ? (
              <s-stack direction="inline">
                <s-button variant="tertiary" href="/app/setup">
                  Open the setup guide
                </s-button>
              </s-stack>
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

        <s-section heading="This installation">
          <s-stack direction="block" gap="small-400">
            <s-text color="subdued">{`Shopify store ${shopDomain}`}</s-text>
            <s-text color="subdued">
              {activated
                ? "Synchronization is active."
                : "Synchronization has not been started."}
            </s-text>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
