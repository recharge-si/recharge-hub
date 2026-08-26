/**
 * Where a setting lives in MetaKocka's own UI.
 *
 * Several things this app needs cannot be created through the API (CLAUDE.md
 * §3): profit centres, warehouses and pricelists must pre-exist and be
 * referenced by exact string. So "add it in MetaKocka first" is advice the app
 * gives regularly, and it needs somewhere to point.
 *
 * Linking out is not the thing §2.7 forbids. Every workflow stays completable
 * inside the Shopify admin; these only open the place the source list is kept.
 *
 * One module rather than a constant per route, because the same screen is
 * referenced from more than one page and a stale URL in one of them is not
 * something anybody would notice until a merchant followed it.
 */

/** Settings and Registers: payment types, profit centres. */
export const METAKOCKA_REGISTERS_URL =
  "https://main.metakocka.si/index.jsp#nastavitve_sifranti";

/** Warehouses, where a mark and its name are set. */
export const METAKOCKA_WAREHOUSES_URL =
  "https://main.metakocka.si/index.jsp#skladisce_skladisca";

/**
 * Sales and Pricelists, where a pricelist's own id is shown.
 *
 * That id is what this app stores and sends as the pricelist `count_code`, and
 * MetaKocka labels it "Price list ID" on that screen. Worth pointing at
 * precisely, because a merchant told only to "use the pricelist code" has no
 * way to know which of the numbers on a pricelist is the one meant.
 */
export const METAKOCKA_PRICELISTS_URL =
  "https://main.metakocka.si/index.jsp#prodaja_ceniki";
