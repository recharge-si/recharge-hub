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
 * There is no `s-app-nav` here yet, deliberately. The app has one page in M1, and
 * BFS rejects a separate navigation item, in addition to the app name, that
 * points at the app home page. The nav arrives in M2 with the settings screens,
 * which are the first real sub-pages.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AppLayout() {
  return (
    <>
      <AppBridgeNavigation />
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
