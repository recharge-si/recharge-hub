import type { MetakockaClient } from "~/adapters/metakocka/client";
import type { SalesOrderInput } from "~/adapters/metakocka/documents";
import { readPricelistNetPrices } from "~/adapters/metakocka/pricelists";
import type { PartnerPricing } from "~/domain/orders/partner";

/**
 * Partner pricing in the order writer (docs/architecture.md § Who an order is
 * filed against): the reseller's net prices, read from MetaKocka and cached,
 * and the one function that turns an ordinary sales order into the wholesale
 * one.
 */

/** How long a pricelist read is reused for the same shop and pricelist. */
export const PARTNER_PRICE_CACHE_MS = 10 * 60 * 1000;

/**
 * A cached read is refreshed early for a SKU it does not price, but only once
 * it is this old: a product priced a minute ago is worth one more look, and a
 * burst of orders for a product that is simply not on the pricelist must not
 * each rescan a whole catalogue.
 */
const MISS_REFRESH_AFTER_MS = 60 * 1000;

const cache = new Map<string, { at: number; prices: Map<string, string> }>();

/** For tests. */
export function clearPartnerPriceCache(): void {
  cache.clear();
}

/**
 * The net price of each given SKU on the pricelist, and the SKUs it has none
 * for.
 *
 * MetaKocka cannot be asked for a few products' prices (`product_code_list` is
 * ignored with `return_pricelist`), so the whole catalogue is read and kept in
 * memory per shop for ten minutes. A burst of orders reads it once. Per
 * process, which is all it needs to be: a second worker only means a second
 * read.
 */
export async function partnerNetPrices(input: {
  shopDomain: string;
  client: MetakockaClient;
  pricelistCode: string;
  skus: readonly string[];
  now: Date;
}): Promise<{ prices: Map<string, string>; missing: string[] }> {
  const key = `${input.shopDomain}\u0000${input.pricelistCode}`;
  const at = input.now.getTime();

  const read = async () => {
    const prices = await readPricelistNetPrices(
      input.client,
      input.pricelistCode,
      input.now,
    );
    const entry = { at, prices };
    cache.set(key, entry);
    return entry;
  };

  let entry = cache.get(key);
  if (!entry || at - entry.at >= PARTNER_PRICE_CACHE_MS) entry = await read();

  let missing = unpricedSkus(input.skus, entry.prices);
  if (missing.length > 0 && at - entry.at >= MISS_REFRESH_AFTER_MS) {
    entry = await read();
    missing = unpricedSkus(input.skus, entry.prices);
  }

  return { prices: entry.prices, missing };
}

/** A SKU's price and discount as a written document already carries them. */
export interface FrozenPartnerPrice {
  price: string;
  discount: string | null;
}

/**
 * The partner prices a written document was sent with, by SKU.
 *
 * Read back so a document already in MetaKocka keeps the price it was filed
 * at: a pricelist edited next month must not rewrite last month's wholesale
 * orders, and an unchanged order then costs no catalogue read at all. Only a
 * body that was itself partner-priced counts, recognised by its pricelist
 * being the one in force and its lines carrying a net `price`; a document
 * written before partner pricing was turned on is re-priced like a new one.
 */
export function frozenPartnerPrices(
  requestBody: unknown,
  pricelistCode: string,
): Map<string, FrozenPartnerPrice> {
  const frozen = new Map<string, FrozenPartnerPrice>();
  if (!requestBody || typeof requestBody !== "object") return frozen;
  const body = requestBody as Record<string, unknown>;
  if (body.sales_pricelist_code !== pricelistCode) return frozen;
  if (body.receiver !== undefined) return frozen;
  if (!Array.isArray(body.product_list)) return frozen;

  for (const line of body.product_list as unknown[]) {
    if (!line || typeof line !== "object") continue;
    const { code, price, discount } = line as Record<string, unknown>;
    if (typeof code !== "string" || typeof price !== "string") continue;
    frozen.set(code, {
      price,
      discount: typeof discount === "string" ? discount : null,
    });
  }
  return frozen;
}

/**
 * The wholesale sales order, from the one the writer would otherwise send.
 *
 * Pure. Everything about the Shopify sale that does not describe the sale to
 * the partner is taken off: the receiver (the partner ships to its own
 * customer), the shipping line, the document discount and every payment. The
 * pricelist becomes the partner's, and each line is sent at its net price
 * less the partner discount with no VAT (`tax_factor` "0", which MetaKocka
 * stores as tax "000", verified 2026-11-27).
 *
 * `prices` must hold every line's SKU; the caller raises an exception for the
 * ones it does not and writes nothing.
 */
export function applyPartnerPricing(
  input: SalesOrderInput,
  pricing: PartnerPricing,
  prices: ReadonlyMap<string, FrozenPartnerPrice>,
): SalesOrderInput {
  const {
    receiver: _receiver,
    shippingLine: _shipping,
    discountValueMinor: _discount,
    markPaid: _markPaid,
    payments: _payments,
    ...rest
  } = input;

  return {
    ...rest,
    salesPricelistCode: pricing.pricelistCode,
    lines: input.lines.map((line) => {
      const price = prices.get(line.code);
      return {
        ...line,
        netPrice: price?.price ?? null,
        discountPercent: price ? price.discount : null,
        taxFactor: "0",
      };
    }),
  };
}

/** The SKUs on the order that the pricelist has no price for. */
export function unpricedSkus(
  skus: readonly string[],
  prices: ReadonlyMap<string, unknown>,
): string[] {
  return [...new Set(skus.filter((sku) => !prices.has(sku)))];
}
