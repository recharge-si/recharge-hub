import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { componentOf, READINESS_ROUTES } from "~/domain/readiness";
import { ReadinessList } from "~/web/components/readiness-list";
import { SettingRow } from "~/web/components/setting-row";
import { SetupBanner } from "~/web/components/setup-banner";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The MetaKocka integration's front door.
 *
 * Orders, Products and Locations are the same integration seen from three
 * sides, and each is its own page. This one exists so the navigation carries
 * one entry for the job rather than three: how each side is doing, in one
 * line each, and the door to it. Nothing here is edited; nothing here waits
 * on MetaKocka (docs/BUILD_SPEC.md §2.5) — readiness is computed from our own
 * tables.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const readiness = await getReadiness(principal);

  const summaryOf = (key: Parameters<typeof componentOf>[1]) => {
    const component = componentOf(readiness, key);
    return { summary: component.summary, status: component.status };
  };

  return {
    activated: readiness.activated,
    overall: readiness.overall,
    components: readiness.components,
    areas: [
      {
        title: "Orders",
        href: "/app/orders",
        ...summaryOf("orders"),
      },
      {
        title: "Products",
        href: "/app/products",
        ...summaryOf("products"),
      },
      {
        title: "Locations",
        href: "/app/locations",
        ...summaryOf("stock"),
      },
      {
        title: "Connection",
        href: READINESS_ROUTES.connection,
        ...summaryOf("metakocka"),
      },
    ],
  };
};

export default function MetaKocka() {
  const { activated, overall, components, areas } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="MetaKocka">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-button slot="secondary-actions" icon="settings" href="/app/settings">
        Settings
      </s-button>

      <s-stack direction="block" gap="large">
        {!activated ? (
          <SetupBanner components={components} overall={overall} />
        ) : null}

        <s-section>
          <s-stack direction="block" gap="base">
            {areas.map((area) => (
              <SettingRow
                key={area.href}
                label={area.title}
                summary={area.summary}
                {...(area.status === "needs_attention"
                  ? { tone: "critical" as const }
                  : {})}
                action={<s-button href={area.href}>Open</s-button>}
              />
            ))}
          </s-stack>
        </s-section>

        {activated &&
        components.some(
          (component) => component.status === "needs_attention",
        ) ? (
          <s-section heading="Needs answering">
            <ReadinessList components={components} onlyProblems />
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
