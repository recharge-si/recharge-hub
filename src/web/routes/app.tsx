import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Outlet,
  useLoaderData,
  useRouteError,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getSalesOrderSettings } from "~/adapters/db/repositories/sales-order-setting.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { AppBridgeNavigation } from "~/web/components/app-bridge-navigation";
import { MaintenanceBanner } from "~/web/components/maintenance-banner";
import { navFor } from "~/web/lib/navigation";
import { principalFromSession } from "~/web/lib/principal.server";
import { describeStaleSessionError } from "~/web/lib/route-errors";

/**
 * Everything under /app is embedded in the Shopify admin and authenticated by
 * token exchange (CLAUDE.md section 2.2).
 *
 * The nav deliberately has no visible item pointing at the app home. BFS
 * rejects "a separate navigation item in addition to the app name that
 * redirects to the app's homepage": the app name in the admin nav is that
 * link. What the nav does carry is a hidden `rel="home"` entry naming `/app`
 * as the route that name opens — see `web/lib/navigation`.
 *
 * The entries depend on the shop: Orders is left out while order transfer
 * is off. Saving the order settings is an action, and React Router reloads
 * this loader after every action, so the menu follows the switch at once.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSalesOrderSettings(principalFromSession(session));
  return { nav: navFor(settings) };
};

export default function AppLayout() {
  const { nav } = useLoaderData<typeof loader>();

  return (
    <>
      <AppBridgeNavigation />
      {/*
       * Each entry is a thing a merchant does rather than a table this app
       * keeps (the product UX brief, section 13). The list, its order and why
       * are in `web/lib/navigation`. Sub-pages highlight their parent because
       * the path does (section 2.6), which is why a page's address starts with
       * its entry's.
       */}
      <s-app-nav>
        {nav.map((item) => (
          <s-link
            key={item.href}
            href={item.href}
            {...(item.rel ? { rel: item.rel } : {})}
          >
            {item.label}
          </s-link>
        ))}
      </s-app-nav>
      <MaintenanceBanner />
      <Outlet />
    </>
  );
}

// Shopify needs React Router to catch its thrown responses so their headers survive.
export function ErrorBoundary() {
  const error = useRouteError();
  const stale = describeStaleSessionError(error);

  // Auto-redirect on stale session (seamless re-auth, no error screen shown).
  // Redirect to the current page to force a document-level request, which triggers
  // the library's bounce page for re-authentication. After re-auth, the loader
  // runs again with a fresh session. This keeps the user in context, not dropped
  // on the home page.
  useEffect(() => {
    if (stale?.recover === "navigate") {
      window.location.assign(window.location.href);
    }
  }, [stale?.recover]);

  // If redirecting, show nothing while the navigation happens.
  if (stale?.recover === "navigate") {
    return null;
  }

  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
