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
 * Five visible entries. Orders, Products and Locations are all the MetaKocka
 * integration seen from three sides, and three top-level items for one job
 * made the menu longer than the job; they live under one **MetaKocka** entry
 * whose page (`/app/metakocka`) opens onto them. Their own addresses are
 * unchanged, so every link and bookmark still lands.
 */
export const APP_NAV: readonly NavItem[] = [
  { href: APP_HOME, label: "Home", rel: "home" },
  { href: "/app/sales", label: "Sales" },
  { href: "/app/product-setup", label: "Product setup" },
  { href: "/app/metakocka", label: "MetaKocka" },
  { href: "/app/exceptions", label: "Needs attention" },
  { href: "/app/settings", label: "Settings" },
];
