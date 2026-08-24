import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";
import { mkDecimal } from "~/adapters/metakocka/values";

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
 * Every stock row for one warehouse.
 *
 * Fully paginated on purpose. A SKU absent from the result is treated by the
 * caller as zero stock, and that conclusion is only safe once the whole list has
 * been read: a truncated page would otherwise zero out real inventory.
 */
export async function listWarehouseStock(
  client: MetakockaClient,
  warehouseMkId: string,
): Promise<StockLevel[]> {
  const rows: StockLevel[] = [];

  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const response = await client.call(
      ENDPOINTS.warehouseStock,
      { wh_id_list: warehouseMkId, limit: PAGE, offset },
      stockResponseSchema,
    );

    for (const row of response.stock_list) {
      rows.push({
        warehouseId: row.warehouse_id,
        code: row.code,
        title: row.title ?? null,
        amount: row.amount,
        reserved: row.reserved_amount ?? 0,
        free: row.free_amount ?? row.amount - (row.reserved_amount ?? 0),
      });
    }

    if (response.stock_list.length < PAGE) break;
  }

  return rows;
}

const productRowSchema = z
  .object({
    mk_id: z.string(),
    count_code: z.string().optional(),
    code: z.string(),
    name: z.string().optional(),
    unit: z.string().optional(),
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
}

/** The whole article catalogue, paginated. */
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
      products.push({
        mkId: row.mk_id,
        code: row.code,
        name: row.name ?? null,
      });
    }

    if (response.product_list.length < PAGE) break;
  }

  return products;
}
