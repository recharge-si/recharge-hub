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

export const APP_NAV: readonly NavItem[] = [
  { href: APP_HOME, label: "Home", rel: "home" },
  { href: "/app/sales", label: "Sales" },
  { href: "/app/orders", label: "Orders" },
  { href: "/app/exceptions", label: "Needs attention" },
  { href: "/app/products", label: "Products" },
  { href: "/app/locations", label: "Locations" },
  { href: "/app/settings", label: "Settings" },
];
