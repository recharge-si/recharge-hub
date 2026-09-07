import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Outlet,
  useRouteError,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { AppBridgeNavigation } from "~/web/components/app-bridge-navigation";
import { describeStaleSessionError } from "~/web/lib/route-errors";

/**
 * Everything under /app is embedded in the Shopify admin and authenticated by
 * token exchange (CLAUDE.md section 2.2).
 *
 * The nav deliberately has no item pointing at the app home. BFS rejects "a
 * separate navigation item in addition to the app name that redirects to the
 * app's homepage": the app name in the admin nav is that link.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AppLayout() {
  return (
    <>
      <AppBridgeNavigation />
      {/*
       * Five areas, each of which is a thing a merchant does rather than a
       * table this app happens to keep (the product UX brief, section 13).
       *
       * "Order sync", "Payment types" and "Connection" used to sit here beside
       * Orders, which asked the merchant to know that order sync and orders
       * were the same subject and that payment types were part of it. Those are
       * sub-pages now: order behaviour under Orders, the ERP connection under
       * Settings. Sub-pages highlight their parent because the path does
       * (section 2.6).
       */}
      <s-app-nav>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/exceptions">Needs attention</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/locations">Locations</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
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
