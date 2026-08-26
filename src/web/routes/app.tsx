import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Outlet,
  useRouteError,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { AppBridgeNavigation } from "~/web/components/app-bridge-navigation";

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
      <s-app-nav>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/exceptions">Needs attention</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/settings/supply-sources">Locations</s-link>
        <s-link href="/app/settings/payments">Payment types</s-link>
        <s-link href="/app/settings/sales-orders">Order sync</s-link>
        <s-link href="/app/settings/metakocka">Connection</s-link>
      </s-app-nav>
      <Outlet />
    </>
  );
}

// Shopify needs React Router to catch its thrown responses so their headers survive.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
