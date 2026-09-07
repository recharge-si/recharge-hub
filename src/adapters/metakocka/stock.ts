import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { MetakockaError } from "~/adapters/metakocka/errors";
import type { ProductTypeFlags } from "~/adapters/metakocka/products";
import { mkDecimal } from "~/adapters/metakocka/values";
import { getLogger } from "~/adapters/observability/logger.server";

/**
 * `warehouse_stock` and `product_list`.
 *
 * Recorded against a live company: every value is a string, the stock list key
 * is `stock_list`, and `reserved_amount`/`free_amount` are returned without any
 * flag. The product identifier that matches a Shopify SKU is `code`;
 * `count_code` is MetaKocka's own internal numbering.
 */

const stockRowSchema = z
  .object({
    warehouse_id: z.string(),
    mk_id: z.string(),
    count_code: z.string().optional(),
    code: z.string(),
    title: z.string().optional(),
    amount: mkDecimal,
    reserved_amount: mkDecimal.optional(),
    free_amount: mkDecimal.optional(),
    unit: z.string().optional(),
  })
  .passthrough();

const stockResponseSchema = z
  .object({
    stock_list: z.array(stockRowSchema).default([]),
    stock_list_count: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export interface StockLevel {
  warehouseId: string;
  /** Matches a Shopify SKU. */
  code: string;
  title: string | null;
  /** MetaKocka `amount`: physical stock. §7 publishes this as Shopify on hand. */
  amount: number;
  reserved: number;
  free: number;
}

const PAGE = 500;

/**
 * Every stock row for one warehouse, aggregated to one row per product.
 *
 * Fully paginated on purpose. A SKU absent from the result is treated by the
 * caller as zero stock, and that conclusion is only safe once the whole list has
 * been read: a truncated page would otherwise zero out real inventory.
 *
 * A live company can return more than one row for the same
 * `(warehouse_id, code)` pair — separate microlocations inside one physical
 * warehouse. Those are summed, so a caller sees the warehouse's true total
 * rather than whichever microlocation happened to come last.
 *
 * **Only the warehouse that was asked for comes back.** `wh_id_list` is a
 * server-side filter no recorded `warehouse_stock` response has ever proved,
 * and every caller keys this result by product code alone — so a response
 * that also carried another warehouse was folded in as though it belonged
 * here. In the Shopify → MetaKocka direction that is not a display bug:
 * `pushShopifyStockIntoMetakocka` builds one map per warehouse and sends all
 * of them in a single `sync_stock` request, so every warehouse received every
 * warehouse's stock and the company total for a product came out multiplied
 * by the number of warehouses — two warehouses, exactly double. Filtering
 * here, once, is what makes that impossible however `wh_id_list` behaves.
 */
export async function listWarehouseStock(
  client: MetakockaClient,
  warehouseMkId: string,
): Promise<StockLevel[]> {
  interface Aggregate {
    warehouseId: string;
    code: string;
    title: string | null;
    amount: number;
    reserved: number;
    /** Summed only while every contributing row has carried it; see below. */
    free: number | null;
  }

  const byCode = new Map<string, Aggregate>();
  /** Rows for another warehouse: proof `wh_id_list` did not filter. */
  let foreign = 0;

  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const response = await client.call(
      ENDPOINTS.warehouseStock,
      { wh_id_list: warehouseMkId, limit: PAGE, offset },
      stockResponseSchema,
    );

    for (const row of response.stock_list) {
      if (row.warehouse_id !== warehouseMkId) {
        foreign += 1;
        continue;
      }

      const reserved = row.reserved_amount ?? 0;
      const existing = byCode.get(row.code);

      if (!existing) {
        byCode.set(row.code, {
          warehouseId: row.warehouse_id,
          code: row.code,
          title: row.title ?? null,
          amount: row.amount,
          reserved,
          free: row.free_amount ?? null,
        });
        continue;
      }

      existing.amount += row.amount;
      existing.reserved += reserved;
      // free_amount is summed only if every microlocation reported it —
      // one row missing it makes the running total meaningless, and the
      // fallback below recomputes it from the (always present) aggregate
      // amount and reserved instead.
      existing.free =
        existing.free === null || row.free_amount === undefined
          ? null
          : existing.free + row.free_amount;
      existing.title ??= row.title ?? null;
    }

    if (response.stock_list.length < PAGE) break;
  }

  if (foreign > 0) {
    // Dropped rather than trusted, so this is not fatal on its own — but it
    // means every read here is paying for the whole company's stock list,
    // and it is the one condition that makes the refusal below possible.
    getLogger().warn(
      { warehouseMkId, foreignRows: foreign, kept: byCode.size },
      "warehouse_stock returned rows for other warehouses; wh_id_list did not filter",
    );
  }

  /*
   * Rows came back, and none of them were for the warehouse that was asked
   * for.
   *
   * That is not an empty warehouse: an empty warehouse returns nothing at
   * all. It means the `warehouse_id` MetaKocka answers with and the `mk_id`
   * this app holds are not the same identifier — and every caller reads an
   * empty result as “every product is at zero”, which publishes zero on-hand
   * into Shopify or sends a `sync_stock` request that empties the warehouse.
   * Refusing is the only safe answer.
   */
  if (foreign > 0 && byCode.size === 0) {
    throw new MetakockaError(
      `warehouse_stock returned ${foreign} row(s), none of them for warehouse ${warehouseMkId}. Stock was not read; reload the warehouse list and check this location's mapping.`,
      { endpoint: ENDPOINTS.warehouseStock, kind: "exception" },
    );
  }

  return [...byCode.values()].map((row) => ({
    warehouseId: row.warehouseId,
    code: row.code,
    title: row.title,
    amount: row.amount,
    reserved: row.reserved,
    free: row.free ?? row.amount - row.reserved,
  }));
}

const productRowSchema = z
  .object({
    mk_id: z.string(),
    count_code: z.string().optional(),
    code: z.string(),
    name: z.string().optional(),
    unit: z.string().optional(),
    // The three type flags, as MetaKocka sends everything: strings.
    sales: z.string().optional(),
    purchasing: z.string().optional(),
    service: z.string().optional(),
  })
  .passthrough();

const productResponseSchema = z
  .object({
    product_list: z.array(productRowSchema).default([]),
  })
  .passthrough();

export interface MetakockaProduct {
  mkId: string;
  /** Matches a Shopify SKU. */
  code: string;
  name: string | null;
  /**
   * Prodajni / Nabavni / Storitev as the catalogue currently holds them, or
   * null when the response did not carry all three.
   *
   * Null is "we do not know", not "all false", and the difference matters:
   * a caller that treated an absent flag as false would rewrite the type of
   * every article on every run.
   */
  type: ProductTypeFlags | null;
}

/** MetaKocka sends booleans as "true"/"false"; anything else is unknown. */
function flagOf(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  return null;
}

function typeOf(row: {
  sales?: string | undefined;
  purchasing?: string | undefined;
  service?: string | undefined;
}): ProductTypeFlags | null {
  const sales = flagOf(row.sales);
  const purchasing = flagOf(row.purchasing);
  const service = flagOf(row.service);
  if (sales === null || purchasing === null || service === null) return null;
  return { sales, purchasing, service };
}

/**
 * What a lookup by code can honestly conclude.
 *
 * Three answers, not two. "Absent" is a claim about the merchant's catalogue
 * and it refuses their save, so it is only returned when the whole catalogue
 * was read and the code was not in it. Everything short of that — a filter
 * that may not have been applied, a catalogue longer than this is willing to
 * walk — is `unknown`, which is not an answer worth blocking a save over.
 */
export type ProductLookup =
  | { status: "found"; product: MetakockaProduct }
  | { status: "absent" }
  | { status: "unknown" };

/** Codes are compared the way a person reads them, not the way bytes compare. */
function codeKey(value: string): string {
  return value.trim().toLowerCase();
}

function productOf(row: {
  mk_id: string;
  code: string;
  name?: string | undefined;
  sales?: string | undefined;
  purchasing?: string | undefined;
  service?: string | undefined;
}): MetakockaProduct {
  return {
    mkId: row.mk_id,
    code: row.code,
    name: row.name ?? null,
    type: typeOf(row),
  };
}

/**
 * How far this will walk before it gives up and says it does not know. Ten
 * pages is five thousand articles, which is more than a catalogue this app has
 * ever been pointed at, and a bound is what stops one save request from
 * reading an unbounded catalogue a page at a time.
 */
const MAX_LOOKUP_PAGES = 10;

/**
 * One product, by the code the merchant typed.
 *
 * For validating a shipping article on the settings screen, which is the one
 * place a merchant hands this app a MetaKocka code by hand. A code that does
 * not exist is worth catching there rather than on the next order, where it
 * surfaces as a rejected sales order and a puzzle.
 *
 * It asks with `product_code_list` first, because when that filter is applied
 * the answer costs one small call. **No recorded response proves `product_list`
 * applies it** — it is verified on `warehouse_stock` and assumed here — so a
 * miss proves nothing and is not reported as one: a merchant whose shipping
 * article exists was told it did not, and their settings would not save. The
 * miss falls through to reading the catalogue, which is the same walk
 * `listProducts` does and is answering a question the merchant asked for.
 *
 * Matching ignores case and surrounding space, because "Shipping" typed as
 * "SHIPPING" is the same article to everyone except a byte comparison.
 */
export async function findProductByCode(
  client: MetakockaClient,
  code: string,
): Promise<ProductLookup> {
  const wanted = codeKey(code);
  if (wanted === "") return { status: "absent" };

  const filtered = await client.call(
    ENDPOINTS.productList,
    { limit: PAGE, offset: 0, product_code_list: [{ code }] },
    productResponseSchema,
  );

  const hit = filtered.product_list.find((row) => codeKey(row.code) === wanted);
  if (hit) return { status: "found", product: productOf(hit) };

  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const response = await client.call(
      ENDPOINTS.productList,
      { limit: PAGE, offset: page * PAGE },
      productResponseSchema,
    );

    const row = response.product_list.find(
      (entry) => codeKey(entry.code) === wanted,
    );
    if (row) {
      getLogger().warn(
        { code, page },
        "product_code_list did not return the article the catalogue holds",
      );
      return { status: "found", product: productOf(row) };
    }

    // A short page is the end of the catalogue, and only then is "absent" a
    // fact rather than a guess.
    if (response.product_list.length < PAGE) return { status: "absent" };
  }

  return { status: "unknown" };
}

/** The whole product catalogue, paginated. */
export async function listProducts(
  client: MetakockaClient,
): Promise<MetakockaProduct[]> {
  const products: MetakockaProduct[] = [];

  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const response = await client.call(
      ENDPOINTS.productList,
      { limit: PAGE, offset },
      productResponseSchema,
    );

    for (const row of response.product_list) {
      products.push(productOf(row));
    }

    if (response.product_list.length < PAGE) break;
  }

  return products;
}
