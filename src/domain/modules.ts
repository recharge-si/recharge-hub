/**
 * Optional modules, so one codebase can run as the full Recharge Hub or as a
 * plain Shopify ↔ MetaKocka connector for another store.
 *
 * The MetaKocka part — orders, payments, taxes, stock, locations, the SKU
 * match and the exceptions queue — is the core and cannot be switched off.
 * Everything listed here is something a store may not want: it is hidden from
 * the menu and the home page, its pages answer 404, its webhooks are dropped
 * and its scheduled jobs are not sent. Data a module already wrote stays in
 * the database untouched, so switching a module back on resumes where it was.
 *
 * Which modules run is per deployment (`APP_MODULES`), because each store
 * already has its own deployment of this app (custom distribution, D-01).
 */
export const OPTIONAL_MODULES = [
  "sales",
  "catalogue",
  "translations",
  "sources",
] as const;

export type AppModule = (typeof OPTIONAL_MODULES)[number];

export type ModuleSet = ReadonlySet<AppModule>;

export const ALL_MODULES: ModuleSet = new Set(OPTIONAL_MODULES);

/**
 * Parses `APP_MODULES`: blank or `all` is every module, `none` is the
 * connector alone, otherwise a comma-separated list. An unknown name is an
 * error rather than ignored, so a typo cannot quietly switch a module off.
 */
export function parseModules(value: string | undefined): ModuleSet {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "" || raw === "all") return ALL_MODULES;
  if (raw === "none") return new Set();

  const modules = new Set<AppModule>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "") continue;
    if (!isModule(name)) {
      throw new Error(
        `Unknown module "${name}" in APP_MODULES. Known: ${OPTIONAL_MODULES.join(", ")}, or "all" / "none".`,
      );
    }
    modules.add(name);
  }
  return modules;
}

function isModule(name: string): name is AppModule {
  return (OPTIONAL_MODULES as readonly string[]).includes(name);
}

/** Path prefixes under the embedded app that belong to a module. */
const MODULE_PATHS: ReadonlyArray<readonly [string, AppModule]> = [
  ["/app/sales", "sales"],
  ["/app/products", "catalogue"],
  ["/app/product-setup", "catalogue"],
  ["/app/translations", "translations"],
  ["/app/sources", "sources"],
];

/** The module a path belongs to, or null for a core page. */
export function moduleForPath(pathname: string): AppModule | null {
  // A single-fetch data request may still carry its `.data` suffix.
  const path = pathname.replace(/\.data$/, "");
  for (const [prefix, module] of MODULE_PATHS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return module;
  }
  return null;
}

/** Whether a link inside the app points at a page that is switched on. */
export function pathEnabled(pathname: string, modules: ModuleSet): boolean {
  const module = moduleForPath(pathname);
  return module === null || modules.has(module);
}
