import { readdirSync, readFileSync } from "node:fs";

import type { Config } from "@react-router/dev/config";

/**
 * Hosts whose form submissions the server accepts.
 *
 * React Router rejects an action whose `Origin` header differs from the
 * request URL's origin, scheme included (7.18.3). Behind nginx, TLS ends at
 * the proxy and `react-router-serve` does not trust `X-Forwarded-Proto`, so
 * the server sees `http://` while the browser sends `https://` — and every
 * action came back 400 "Bad Request". The app's own host is not a cross-site
 * origin, so it is listed here: the deployed URL from every `shopify.app*.toml`,
 * and the tunnel the Shopify CLI passes as `SHOPIFY_APP_URL` in development.
 */
function ownHosts(): string[] {
  const urls = [process.env.SHOPIFY_APP_URL];
  // Every app config in the checkout: one image serves each store's own
  // deployment (shopify.app.toml for Recharge, shopify.app.<name>.toml for
  // the others), and each is reached on its own domain.
  let configs: string[] = [];
  try {
    configs = readdirSync(".").filter((file) =>
      /^shopify\.app(\.[\w-]+)?\.toml$/.test(file),
    );
  } catch {
    // Unreadable directory; the environment is all there is.
  }
  for (const file of configs) {
    try {
      const toml = readFileSync(file, "utf8");
      urls.push(/^application_url\s*=\s*"([^"]+)"/m.exec(toml)?.[1]);
    } catch {
      // Unreadable config; skip it.
    }
  }
  const hosts = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Not a URL; nothing to allow.
    }
  }
  return [...hosts];
}

export default {
  // The layout in docs/BUILD_SPEC.md section 5 puts the web tier under src/web
  // rather than the template's top-level app/ directory.
  appDirectory: "src/web",
  ssr: true,
  // The e2e build (vite.config.ts) is kept apart from the production one.
  buildDirectory: process.env.E2E_BUILD === "1" ? "build-e2e" : "build",
  allowedActionOrigins: ownHosts(),
  // Route middleware: `routes/app.tsx` uses it to close the pages of a
  // module this deployment does not run, actions included.
  future: { v8_middleware: true },
} satisfies Config;
