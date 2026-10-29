/**
 * The primary navigation, as data, so a test can hold it to the rules.
 *
 * Two rules from docs/BUILD_SPEC.md section 2.6 and one from the admin itself:
 *
 *  - No nav item that just links to the app home. The app's name in the admin
 *    nav is that link, so there is no visible "Home" entry.
 *  - Every entry stays inside the authenticated embedded app, under `/app`.
 *  - **The home route is named.** App Bridge links the app's name to `/`
 *    unless the nav says otherwise, and a client-side navigation to `/` has
 *    no `shop` or `host` to say it came from the admin. Naming `/app` as the
 *    home route with `rel="home"` makes the app's name open Home directly,
 *    and the entry is hidden from the rendered menu, which is exactly what
 *    the first rule asks for.
 */
export interface NavItem {
  href: string;
  label: string;
  rel?: "home";
}

export const APP_HOME = "/app";

/**
 * Nine visible entries, in the order a merchant reaches for them. The admin
 * draws the list with no groups or dividers, so the order is the grouping:
 *
 *  1. **Needs attention** first: the one place everything in the app that
 *     wants a person — orders, sales, translations, stopped jobs — lands.
 *  2. **Orders** and **Sales**, the daily work. Orders sat behind the MetaKocka
 *     page for a while, which put the most-used page two clicks away and left
 *     no entry highlighted while it was open.
 *  3. **Products**, **Product setup** and **Translations**, the catalogue.
 *     Products opens each product's workspace, where it is edited here
 *     rather than in Shopify's product editor.
 *  4. **MetaKocka** and **Sources**, the two systems that feed the store.
 *     MetaKocka's page opens onto its products, locations and connection, and
 *     those live under `/app/metakocka/` so its entry is the one highlighted
 *     (the admin highlights the entry the current path starts with).
 *     Sources (docs/sources.md) is what the export portal pushes in.
 *  5. **Settings** last.
 */
export const APP_NAV: readonly NavItem[] = [
  { href: APP_HOME, label: "Home", rel: "home" },
  { href: "/app/exceptions", label: "Needs attention" },
  { href: "/app/orders", label: "Orders" },
  { href: "/app/sales", label: "Sales" },
  { href: "/app/products", label: "Products" },
  { href: "/app/product-setup", label: "Product setup" },
  { href: "/app/translations", label: "Translations" },
  { href: "/app/metakocka", label: "MetaKocka" },
  { href: "/app/sources", label: "Sources" },
  { href: "/app/settings", label: "Settings" },
];

const ORDERS_HREF = "/app/orders";

/**
 * The navigation for one shop. With order transfer turned off, orders are
 * received but none reach MetaKocka, and a top-level entry for them is a
 * daily page that has nothing to do. The pages themselves stay: the
 * MetaKocka page and Settings still open Orders, which is where the
 * switch that turns transfer back on lives.
 */
export function navFor(shop: { transferOrders: boolean }): readonly NavItem[] {
  return shop.transferOrders
    ? APP_NAV
    : APP_NAV.filter((item) => item.href !== ORDERS_HREF);
}
