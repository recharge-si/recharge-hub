/**
 * One answer to "is this integration configured", shared by every screen that
 * asks (the product UX brief, section 23).
 *
 * Before this existed each screen decided for itself: the home page called a
 * shop set up when it had a verified credential, one ready supply source and
 * any payment mapping at all; the locations page had its own idea; the order
 * settings page had a third. Three definitions of "configured" is three
 * different answers to the same merchant question, and the one thing a setup
 * state has to be is consistent.
 *
 * Pure on purpose (docs/BUILD_SPEC.md section 5). Every fact below is something
 * our own database already holds, so readiness can be computed on any page load
 * without waiting for MetaKocka (section 2.5) and can be tested without a
 * database.
 */

export type StockDirectionValue = "mk_to_shopify" | "shopify_to_mk" | "none";

export type ReadinessStatus =
  /** Configured and working as far as our own records can tell. */
  | "ready"
  /** Something a merchant has to do. Only this one is ever coloured. */
  | "needs_attention"
  /** Deliberately switched off. Not a problem. */
  | "disabled"
  /** Never required. Products is the only one today. */
  | "optional";

export type ReadinessKey =
  | "metakocka"
  | "warehouses"
  | "stock"
  | "orders"
  | "payments"
  | "taxes"
  | "products";

export interface ReadinessAction {
  label: string;
  href: string;
}

export interface ReadinessComponent {
  key: ReadinessKey;
  /** The merchant's word for this area. */
  title: string;
  status: ReadinessStatus;
  /** What it currently is, in one line. Always present, healthy or not. */
  summary: string;
  /** Why it needs attention, and what to do. Null when nothing is wrong. */
  reason: string | null;
  /** Where the merchant can act on it. */
  action: ReadinessAction | null;
  /**
   * Whether `needs_attention` here blocks activation. Products never does;
   * stock only does when a location writes into MetaKocka and cannot.
   */
  required: boolean;
}

export interface Readiness {
  components: ReadinessComponent[];
  /** Required components that need attention, in the order shown. */
  blocking: ReadinessComponent[];
  /** True when nothing required needs attention. */
  overall: "ready" | "needs_attention";
  /**
   * Whether the merchant has pressed Finish setup. Separate from `overall` on
   * purpose (section 29): this is UI state, `overall` is configuration.
   */
  activated: boolean;
}

/**
 * Where each area is configured. Held here rather than at the call sites so
 * "the payments component" and "the page that fixes payments" cannot drift.
 */
export const READINESS_ROUTES = {
  connection: "/app/settings/metakocka",
  locations: "/app/locations",
  orders: "/app/orders/settings",
  payments: "/app/orders/settings/payments",
  taxes: "/app/settings/taxes",
  products: "/app/products",
  setup: "/app/setup",
} as const;

export interface ReadinessFacts {
  metakocka: {
    connected: boolean;
    verified: boolean;
    companyId: string | null;
    apiUserEmail: string | null;
  };
  warehouses: {
    /** Supply sources holding both a Shopify location and a MetaKocka warehouse. */
    connectedCount: number;
    /** Sources that have a warehouse but no Shopify location, or the reverse. */
    incompleteNames: string[];
  };
  stock: {
    defaultDirection: StockDirectionValue;
    /** Connected locations counted in MetaKocka. */
    intoShopifyCount: number;
    /** Connected locations counted in Shopify, which need `api_user_email`. */
    intoMetakockaCount: number;
    /** Locations whose last stock run failed. */
    failingNames: string[];
  };
  payments: {
    enabled: boolean;
    /** Gateways this shop's own orders have actually arrived on. */
    seenGateways: string[];
    mappedGateways: string[];
    fallback: string | null;
  };
  orders: {
    shippingProductCode: string | null;
    discountRepresentation: "none" | "document_discount_value";
    /**
     * Whether one Shopify order becomes one MetaKocka sales order or several.
     *
     * Read by the *warehouses* component, not by the orders one, because it
     * changes what a missing warehouse mapping means: a shop writing one
     * unsplit sales order files orders perfectly well without any mapping at
     * all. Mapping still matters — stock synchronization is the other half of
     * this connector and has nowhere to run without it — so the component stays
     * required and only stops claiming the wrong reason.
     */
    salesOrderSplit: "per_warehouse" | "single";
  };
  products: {
    matched: number;
    unmatched: number;
  };
  /**
   * The tax diagnostics, already computed (`domain/tax/diagnostics`). Carried
   * as its verdict rather than re-derived here, so Home and the Taxes & VAT
   * page cannot disagree about whether taxes are configured.
   */
  taxes: {
    status: "ready" | "needs_attention";
    /** The home rate as configured, "Slovenia 22%", or null. */
    domestic: string | null;
    /** Rates orders use, or the configuration expects, with no mapping. */
    unmappedRates: string[];
    /** Orders currently held by an open tax exception. */
    blockedOrders: number;
  };
  /** Null until the merchant presses Finish setup. */
  setupCompletedAt: Date | null;
}

function list(names: string[], limit = 3): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function metakockaOf(facts: ReadinessFacts): ReadinessComponent {
  const base = {
    key: "metakocka" as const,
    title: "MetaKocka",
    required: true,
    action: { label: "Open connection", href: READINESS_ROUTES.connection },
  };

  if (!facts.metakocka.connected) {
    return {
      ...base,
      status: "needs_attention",
      summary: "Not connected",
      reason:
        "Nothing reaches MetaKocka and no stock is published until the company ID and secret key are saved.",
    };
  }

  if (!facts.metakocka.verified) {
    return {
      ...base,
      status: "needs_attention",
      summary: "Not verified",
      reason:
        "The credentials are saved but MetaKocka has not answered with them yet. Test the connection.",
    };
  }

  return {
    ...base,
    status: "ready",
    summary: facts.metakocka.companyId
      ? `Connected to company ${facts.metakocka.companyId}`
      : "Connected",
    reason: null,
  };
}

function warehousesOf(facts: ReadinessFacts): ReadinessComponent {
  const base = {
    key: "warehouses" as const,
    title: "Warehouses",
    required: true,
    action: { label: "Open locations", href: READINESS_ROUTES.locations },
  };

  const { connectedCount, incompleteNames } = facts.warehouses;

  if (connectedCount === 0) {
    return {
      ...base,
      status: "needs_attention",
      summary: "No locations connected",
      reason:
        facts.orders.salesOrderSplit === "single"
          ? "A Shopify location has to point at a MetaKocka warehouse before stock can be synchronized. Sales orders are unaffected: this shop writes one for the whole order, with no warehouse on it."
          : "A Shopify location has to point at a MetaKocka warehouse before an order can be filed anywhere.",
    };
  }

  return {
    ...base,
    status: "ready",
    summary: `${connectedCount} ${plural(connectedCount, "location", "locations")} connected`,
    reason:
      incompleteNames.length > 0
        ? `${list(incompleteNames)} ${plural(incompleteNames.length, "is", "are")} unfinished, so ${plural(incompleteNames.length, "it holds", "they hold")} no stock and take no orders.`
        : null,
  };
}

function stockOf(facts: ReadinessFacts): ReadinessComponent {
  const {
    defaultDirection,
    intoShopifyCount,
    intoMetakockaCount,
    failingNames,
  } = facts.stock;
  const base = {
    key: "stock" as const,
    title: "Stock",
    action: { label: "Open locations", href: READINESS_ROUTES.locations },
  };

  const syncing = intoShopifyCount + intoMetakockaCount;

  if (syncing === 0) {
    return {
      ...base,
      required: false,
      status: defaultDirection === "none" ? "disabled" : "needs_attention",
      summary: "Not synchronized",
      reason:
        defaultDirection === "none"
          ? null
          : "No connected location is copying stock, so quantities in Shopify and MetaKocka can drift apart.",
    };
  }

  const parts: string[] = [];
  if (intoShopifyCount > 0) {
    parts.push(
      `MetaKocka to Shopify for ${intoShopifyCount} ${plural(intoShopifyCount, "location", "locations")}`,
    );
  }
  if (intoMetakockaCount > 0) {
    parts.push(
      `Shopify to MetaKocka for ${intoMetakockaCount} ${plural(intoMetakockaCount, "location", "locations")}`,
    );
  }
  const summary = parts.join(", ");

  /*
   * `sync_stock` is the one MetaKocka call the secret key alone cannot make
   * (docs/BUILD_SPEC.md section 7): it needs an API user email. A shop counting
   * stock in Shopify without one publishes nothing into the ERP, and nothing
   * else on any screen would say so, which is why this is the one stock
   * condition that blocks activation.
   */
  if (intoMetakockaCount > 0 && !facts.metakocka.apiUserEmail) {
    return {
      ...base,
      required: true,
      status: "needs_attention",
      summary,
      reason:
        "MetaKocka needs an API user email before it accepts a stock update, and none is saved.",
      action: { label: "Open connection", href: READINESS_ROUTES.connection },
    };
  }

  if (failingNames.length > 0) {
    return {
      ...base,
      required: false,
      status: "needs_attention",
      summary,
      reason: `Stock is not moving for ${list(failingNames)}.`,
    };
  }

  return { ...base, required: false, status: "ready", summary, reason: null };
}

function paymentsOf(facts: ReadinessFacts): ReadinessComponent {
  const base = {
    key: "payments" as const,
    title: "Payments",
    action: { label: "Open payments", href: READINESS_ROUTES.payments },
  };

  if (!facts.payments.enabled) {
    return {
      ...base,
      required: false,
      status: "disabled",
      summary: "Not recorded in MetaKocka",
      reason: null,
    };
  }

  const mapped = new Set(facts.payments.mappedGateways);
  const unmapped = facts.payments.seenGateways.filter(
    (gateway) => !mapped.has(gateway),
  );
  const mappedCount = facts.payments.mappedGateways.length;

  /*
   * A payment type is never guessed (docs/BUILD_SPEC.md section 8.7). The
   * fallback is the merchant's own answer for every gateway with no row of its
   * own, so it is what makes an unmapped method safe rather than silent:
   * without one, an order paid on a method nobody mapped cannot be recorded at
   * all.
   */
  if (!facts.payments.fallback) {
    return {
      ...base,
      required: true,
      status: "needs_attention",
      summary:
        mappedCount === 0
          ? "No payment methods mapped"
          : `${mappedCount} ${plural(mappedCount, "method", "methods")} mapped`,
      reason:
        unmapped.length > 0
          ? `${unmapped.length} payment ${plural(unmapped.length, "method this store has used is not", "methods this store has used are not")} mapped and there is no fallback, so ${plural(unmapped.length, "an order", "orders")} paid that way cannot be recorded in MetaKocka.`
          : "Choose the payment type to use for any method with no mapping of its own.",
    };
  }

  /*
   * The count alone was not the state of things. A shop with a fallback and one
   * mapped gateway read "1 method mapped" wherever this is shown, which sounds
   * like the other methods are unanswered when the merchant has in fact
   * answered for all of them at once. What is true is that every method is
   * covered, and one of them has a type of its own.
   */
  return {
    ...base,
    required: true,
    status: "ready",
    summary:
      mappedCount === 0
        ? `Every payment method settles into ${facts.payments.fallback}`
        : `${mappedCount} ${plural(mappedCount, "method", "methods")} mapped; anything else settles into ${facts.payments.fallback}`,
    reason:
      unmapped.length > 0
        ? `${unmapped.length} ${plural(unmapped.length, "method", "methods")} this store has used ${plural(unmapped.length, "has", "have")} no type of ${plural(unmapped.length, "its", "their")} own: ${list(unmapped)}.`
        : null,
  };
}

function ordersOf(
  facts: ReadinessFacts,
  metakocka: ReadinessComponent,
  warehouses: ReadinessComponent,
): ReadinessComponent {
  const base = {
    key: "orders" as const,
    title: "Orders",
    required: true,
    action: { label: "Open order settings", href: READINESS_ROUTES.orders },
  };

  /*
   * A warehouse mapping only gates orders for a shop that splits them.
   *
   * A shop writing one sales order for the whole Shopify order puts no
   * warehouse on it, so an unmapped location stops nothing here — it stops
   * stock synchronization, which the warehouses component says in its own
   * words. Reporting orders as waiting on it would colour a working
   * integration red and send the merchant to fix something orders do not use.
   */
  const waitingOnWarehouses =
    facts.orders.salesOrderSplit !== "single" && warehouses.status !== "ready";

  if (metakocka.status !== "ready" || waitingOnWarehouses) {
    return {
      ...base,
      status: "needs_attention",
      summary: "Waiting on setup",
      reason:
        metakocka.status !== "ready"
          ? "Orders reach MetaKocka once the connection works."
          : "Orders are filed once at least one Shopify location points at a MetaKocka warehouse.",
    };
  }

  /*
   * Shipping and a discount have no safe default (docs/project-status.md
   * T-05/T-06), and an order carrying one is reported rather than sent short.
   * That is a per-order condition rather than a broken integration, so it is a
   * note on a working component instead of a red one: the affected orders turn
   * up under Needs attention with the amount named.
   */
  const missing: string[] = [];
  if (!facts.orders.shippingProductCode) missing.push("Shipping");
  if (facts.orders.discountRepresentation === "none") missing.push("discounts");

  return {
    ...base,
    status: "ready",
    summary: "Automatic",
    reason:
      missing.length > 0
        ? `${missing.join(" and ")} ${plural(missing.length, "has", "have")} nowhere to go on a MetaKocka sales order yet, so an order carrying ${plural(missing.length, "one", "them")} is reported instead of counted as reconciled.`
        : null,
  };
}

function productsOf(facts: ReadinessFacts): ReadinessComponent {
  const { matched, unmatched } = facts.products;

  return {
    key: "products",
    title: "Products",
    required: false,
    status: "optional",
    summary:
      matched + unmatched === 0
        ? "Not matched yet"
        : `${matched} of ${matched + unmatched} matched`,
    reason:
      unmatched > 0
        ? `${unmatched} Shopify ${plural(unmatched, "SKU has", "SKUs have")} no MetaKocka product, so ${plural(unmatched, "an order", "orders")} containing ${plural(unmatched, "it", "them")} cannot be sent.`
        : null,
    action: { label: "Open products", href: READINESS_ROUTES.products },
  };
}

/**
 * Taxes. Never blocks activation: an order whose VAT cannot be filed safely is
 * held on its own, one at a time, which is the safer place to be strict. What
 * this reports is whether anything is held right now and whether a rate in
 * use has no MetaKocka mapping — the two things a person can act on.
 */
function taxesOf(facts: ReadinessFacts): ReadinessComponent {
  const base = {
    key: "taxes" as const,
    title: "Taxes",
    required: false,
    action: { label: "Open Taxes & VAT", href: READINESS_ROUTES.taxes },
  };
  const { status, domestic, unmappedRates, blockedOrders } = facts.taxes;

  if (status === "ready") {
    return {
      ...base,
      status: "ready",
      summary: domestic ? `Configured, ${domestic}` : "Configured",
      reason: null,
    };
  }

  const reasons: string[] = [];
  if (!domestic) {
    reasons.push("No home VAT rate is set, so an order Shopify charges no tax on has nothing to stand in for the rate.");
  }
  if (unmappedRates.length > 0) {
    reasons.push(
      `${list(unmappedRates.map((rate) => `${rate}%`))} ${plural(unmappedRates.length, "has", "have")} no MetaKocka mapping, so orders using ${plural(unmappedRates.length, "it", "them")} are held.`,
    );
  }
  if (blockedOrders > 0) {
    reasons.push(
      `${blockedOrders} ${plural(blockedOrders, "order is", "orders are")} held until their VAT can be filed safely.`,
    );
  }

  return {
    ...base,
    status: "needs_attention",
    summary:
      blockedOrders > 0
        ? `${blockedOrders} ${plural(blockedOrders, "issue", "issues")}`
        : unmappedRates.length > 0
          ? `${unmappedRates.length} ${plural(unmappedRates.length, "rate", "rates")} not mapped`
          : "Not configured",
    reason: reasons.join(" ") || "The tax diagnostics name what to change.",
  };
}

export function computeReadiness(facts: ReadinessFacts): Readiness {
  const metakocka = metakockaOf(facts);
  const warehouses = warehousesOf(facts);
  const stock = stockOf(facts);
  const orders = ordersOf(facts, metakocka, warehouses);
  const payments = paymentsOf(facts);
  const taxes = taxesOf(facts);
  const products = productsOf(facts);

  const components = [metakocka, warehouses, stock, orders, payments, taxes, products];

  const blocking = components.filter(
    (component) => component.required && component.status === "needs_attention",
  );

  return {
    components,
    blocking,
    overall: blocking.length === 0 ? "ready" : "needs_attention",
    activated: facts.setupCompletedAt !== null,
  };
}

/** The component a screen wants, by key. */
export function componentOf(
  readiness: Readiness,
  key: ReadinessKey,
): ReadinessComponent {
  const found = readiness.components.find((entry) => entry.key === key);
  // Every key is produced by computeReadiness, so this cannot be missing.
  if (!found) throw new Error(`No readiness component for ${key}`);
  return found;
}

/**
 * Which way stock moves for a location, in the words the merchant chose it
 * with. Used by the locations page, onboarding and the dashboard, so the three
 * never describe one setting three ways.
 */
export function describeDirection(direction: StockDirectionValue): {
  /** "MetaKocka", "Shopify", "Not synchronized". */
  countedIn: string;
  /** "MetaKocka to Shopify". Null when nothing is copied. */
  flow: string | null;
} {
  switch (direction) {
    case "mk_to_shopify":
      return { countedIn: "MetaKocka", flow: "MetaKocka to Shopify" };
    case "shopify_to_mk":
      return { countedIn: "Shopify", flow: "Shopify to MetaKocka" };
    default:
      return { countedIn: "Not synchronized", flow: null };
  }
}
