import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
  type LoaderFunctionArgs,
} from "react-router";

import { getEnv } from "~/adapters/config/env.server";

/**
 * CLAUDE.md section 2.2: the App Bridge script goes in `<head>` of every document,
 * before any other script, with the API key on `data-api-key`. It is neither
 * bundled nor lazy-loaded.
 *
 * The login page is the one document rendered outside the admin, so it gets
 * Polaris but not App Bridge -- there is no admin frame there to talk to.
 */
const APP_BRIDGE_SRC = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
const POLARIS_SRC = "https://cdn.shopify.com/shopifycloud/polaris.js";

export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const embedded =
    url.pathname === "/app" ||
    url.pathname.startsWith("/app/") ||
    url.searchParams.has("host") ||
    url.searchParams.has("embedded");

  return { apiKey: getEnv().SHOPIFY_API_KEY, embedded };
};

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");

  return (
    <html lang="en">
      <head>
        {data?.embedded ? (
          <script src={APP_BRIDGE_SRC} data-api-key={data.apiKey} />
        ) : null}
        <script src={POLARIS_SRC} />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
