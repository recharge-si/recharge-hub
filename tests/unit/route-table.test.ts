import { resolve } from "node:path";

import { flatRoutes } from "@react-router/fs-routes";
import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

/**
 * The information architecture, asserted against the router rather than against
 * a list of filenames (the product UX brief, section 13).
 *
 * The one that could genuinely break is `/app/orders/settings`: it lives beside
 * `/app/orders/:orderId`, and if the dynamic segment ever out-ranked the static
 * one the order settings page would silently become a lookup for an order
 * called "settings". React Router ranks static above dynamic, and this is what
 * keeps that from being an assumption.
 */

interface FileRoute {
  path?: string;
  index?: boolean;
  file: string;
  children?: FileRoute[];
}

/** The file-based config, in the shape `matchRoutes` reads. */
function toRouteObjects(routes: FileRoute[]): RouteObject[] {
  return routes.map((route) => {
    const children = route.children
      ? toRouteObjects(route.children)
      : undefined;
    return {
      ...(route.path === undefined ? {} : { path: route.path }),
      ...(route.index ? { index: true as const } : {}),
      ...(children ? { children } : {}),
      // Carried so a match can be named in an assertion.
      id: route.file,
    } as RouteObject;
  });
}

/**
 * `flatRoutes` reads the app directory from a global the React Router CLI sets
 * while it loads the config. Setting it here is what lets this test read the
 * real route files rather than a copy of the convention that could agree with
 * itself while disagreeing with the router. If React Router changes how it
 * passes this, the test fails loudly instead of quietly checking nothing.
 */
declare const globalThis: {
  __reactRouterAppDirectory?: string;
} & typeof global;

async function routeTable(): Promise<RouteObject[]> {
  globalThis.__reactRouterAppDirectory = resolve(process.cwd(), "src/web");
  const routes = (await flatRoutes()) as unknown as FileRoute[];

  // `flatRoutes` returns the children of the framework's own root route.
  return toRouteObjects(routes);
}

/** The file that answers a URL, or null when nothing does. */
async function fileFor(pathname: string): Promise<string | null> {
  const matches = matchRoutes(await routeTable(), pathname);
  const last = matches?.[matches.length - 1];
  return last ? String(last.route.id) : null;
}

describe("route table", () => {
  it("gives order settings its own page rather than treating it as an order id", async () => {
    expect(await fileFor("/app/orders/settings")).toBe(
      "routes/app.orders.settings._index.tsx",
    );
    expect(await fileFor("/app/orders/settings/payments")).toBe(
      "routes/app.orders.settings.payments.tsx",
    );
    expect(await fileFor("/app/orders/abc123")).toBe(
      "routes/app.orders.$orderId.tsx",
    );
  });

  it("registers every area in the primary navigation", async () => {
    expect(await fileFor("/app")).toBe("routes/app._index.tsx");
    expect(await fileFor("/app/orders")).toBe("routes/app.orders._index.tsx");
    expect(await fileFor("/app/exceptions")).toBe("routes/app.exceptions.tsx");
    expect(await fileFor("/app/products")).toBe(
      "routes/app.products._index.tsx",
    );
    expect(await fileFor("/app/locations")).toBe(
      "routes/app.locations._index.tsx",
    );
    expect(await fileFor("/app/sales")).toBe("routes/app.sales._index.tsx");
    expect(await fileFor("/app/product-setup")).toBe(
      "routes/app.product-setup._index.tsx",
    );
    expect(await fileFor("/app/metakocka")).toBe("routes/app.metakocka.tsx");
    expect(await fileFor("/app/settings")).toBe(
      "routes/app.settings._index.tsx",
    );
  });

  it("gives Translations its languages, one language, and its sections", async () => {
    // `app.translations._index.tsx` rather than `app.translations.tsx`, for
    // the reason Locations gives: a leaf with children is a layout with no
    // outlet, and every section would render blank.
    expect(await fileFor("/app/translations")).toBe(
      "routes/app.translations._index.tsx",
    );
    expect(await fileFor("/app/translations/add")).toBe(
      "routes/app.translations.add.tsx",
    );
    expect(await fileFor("/app/translations/languages/de")).toBe(
      "routes/app.translations.languages.$locale.tsx",
    );
    expect(await fileFor("/app/translations/editor")).toBe(
      "routes/app.translations.editor.tsx",
    );
    expect(await fileFor("/app/translations/translate")).toBe(
      "routes/app.translations.translate.tsx",
    );
    // Syncs is a list beside its detail page, the Orders shape again.
    expect(await fileFor("/app/translations/syncs")).toBe(
      "routes/app.translations.syncs._index.tsx",
    );
    expect(await fileFor("/app/translations/syncs/abc123")).toBe(
      "routes/app.translations.syncs.$syncId.tsx",
    );
    expect(await fileFor("/app/translations/glossary")).toBe(
      "routes/app.translations.glossary.tsx",
    );
    expect(await fileFor("/app/translations/usage")).toBe(
      "routes/app.translations.usage.tsx",
    );
  });

  it("gives a sale campaign its editor, its variants and its export", async () => {
    // `app.sales.$campaignId._index.tsx` rather than `app.sales.$campaignId.tsx`,
    // for the reason Locations gives: a leaf with children becomes a layout
    // with no outlet, and the variants page would render as a blank editor.
    expect(await fileFor("/app/sales/abc123")).toBe(
      "routes/app.sales.$campaignId._index.tsx",
    );
    expect(await fileFor("/app/sales/abc123/variants")).toBe(
      "routes/app.sales.$campaignId.variants.tsx",
    );
    // The bracket escapes the dot: this is one segment, not a child called "csv".
    expect(await fileFor("/app/sales/abc123/variants.csv")).toBe(
      "routes/app.sales.$campaignId.variants[.csv].tsx",
    );
  });

  it("keeps the product view beside the products settings page", async () => {
    // A product's numeric id is dynamic; "sync" is static and must still win.
    expect(await fileFor("/app/products/sync")).toBe(
      "routes/app.products.sync.tsx",
    );
    expect(await fileFor("/app/products/123456")).toBe(
      "routes/app.products.$productId.tsx",
    );
  });

  it("gives each area's settings a page under the area itself", async () => {
    // Locations became a layoutless pair the way Orders already was: the page
    // you land on, and the settings behind its header button. Without the
    // rename to `_index`, `app.locations.tsx` would be a parent layout with no
    // outlet and the settings page would render as a blank locations page.
    expect(await fileFor("/app/locations/settings")).toBe(
      "routes/app.locations.settings.tsx",
    );
    expect(await fileFor("/app/products/sync")).toBe(
      "routes/app.products.sync.tsx",
    );
  });

  it("puts Taxes & VAT under Settings, an overview with a page per concern", async () => {
    // `app.settings.taxes._index.tsx` rather than `app.settings.taxes.tsx`,
    // for the reason Locations gives: a leaf with children becomes a layout
    // with no outlet, and every sub-page would render as a blank overview.
    expect(await fileFor("/app/settings/taxes")).toBe(
      "routes/app.settings.taxes._index.tsx",
    );
    expect(await fileFor("/app/settings/taxes/registrations")).toBe(
      "routes/app.settings.taxes.registrations.tsx",
    );
    expect(await fileFor("/app/settings/taxes/rates")).toBe(
      "routes/app.settings.taxes.rates.tsx",
    );
    expect(await fileFor("/app/settings/taxes/mappings")).toBe(
      "routes/app.settings.taxes.mappings.tsx",
    );
    expect(await fileFor("/app/settings/taxes/overrides")).toBe(
      "routes/app.settings.taxes.overrides.tsx",
    );
  });

  it("gives product setup one address per section", async () => {
    // `/app/product-setup` lands on product types; every section is a
    // route of its own so a refresh, a link and Back all work.
    expect(await fileFor("/app/product-setup/types")).toBe(
      "routes/app.product-setup.types.($typeId).tsx",
    );
    // One route, optional segment: the tree with nothing chosen and the tree
    // with a type chosen are the same page.
    expect(await fileFor("/app/product-setup/types/wave")).toBe(
      "routes/app.product-setup.types.($typeId).tsx",
    );
    expect(await fileFor("/app/product-setup/attributes")).toBe(
      "routes/app.product-setup.attributes._index.tsx",
    );
    expect(await fileFor("/app/product-setup/attributes/abc123")).toBe(
      "routes/app.product-setup.attributes.$attributeId.tsx",
    );
    expect(await fileFor("/app/product-setup/sets")).toBe(
      "routes/app.product-setup.sets.tsx",
    );
    expect(await fileFor("/app/product-setup/settings")).toBe(
      "routes/app.product-setup.settings.tsx",
    );
    expect(await fileFor("/app/product-setup/schema.json")).toBe(
      "routes/app.product-setup.schema[.json].tsx",
    );
  });

  it("keeps guided setup reachable at a stable address", async () => {
    expect(await fileFor("/app/setup")).toBe("routes/app.setup.tsx");
  });

  it("keeps the old addresses alive as redirects", async () => {
    expect(await fileFor("/app/settings/sales-orders")).toBe(
      "routes/app.settings.sales-orders.tsx",
    );
    expect(await fileFor("/app/settings/payments")).toBe(
      "routes/app.settings.payments.tsx",
    );
    expect(await fileFor("/app/settings/supply-sources")).toBe(
      "routes/app.settings.supply-sources._index.tsx",
    );
  });
});
