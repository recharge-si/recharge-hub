import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { mkDecimal } from "~/adapters/metakocka/values";
import type { MetakockaCredentials } from "~/adapters/metakocka/client";

/**
 * Writing stock back into MetaKocka, for warehouses that are counted in Shopify.
 *
 * This endpoint is dangerous in two specific ways, both verified:
 *
 *  1. **Omission removes.** The documentation states that "items previously in
 *     stock but omitted from request get removed". A partial list therefore
 *     wipes everything else in that warehouse. `buildCompleteStockList` exists
 *     to make that impossible: products we do not manage are sent back at the
 *     value MetaKocka already holds, so nothing is ever dropped by omission.
 *
 *  2. **A no-op reports success.** Posting without `stock_list` returns
 *     `opr_code 0, "Sync successful"` having done nothing. A malformed payload
 *     would look identical to a real sync, so the response is checked against
 *     what was sent rather than trusted.
 *
 * It also lives on a different base path from every other endpoint: no `v1`,
 * no `json` (probed: `/rest/eshop/v1/sync_stock` and `/rest/eshop/v1/json/
 * sync_stock` both return an HTML 404), and it needs an `api_user_email` that
 * the secret key alone does not carry.
 *
 * Writing stock creates an inventory document in MetaKocka. It is an accounting
 * action, not a cache update.
 */
export const SYNC_STOCK_URL = "https://main.metakocka.si/rest/eshop/sync_stock";

export interface StockLine {
  warehouseId: string;
  productCode: string;
  amount: number;
}

const responseSchema = z
  .object({
    opr_code: z.union([z.string(), z.number()]).transform(String),
    opr_desc: z.string().optional(),
    stock_list: z
      .array(
        z
          .object({
            product_code: z.string().optional(),
            product_id: z.string().optional(),
            warehouse_id: z.string().optional(),
            amount: mkDecimal.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface CompleteListInput {
  /** What Shopify says, for the SKUs this app manages at this location. */
  managed: Map<string, number>;
  /** What MetaKocka currently holds in this warehouse, by product code. */
  current: Map<string, number>;
  warehouseId: string;
}

/**
 * The full stock list for one warehouse.
 *
 * Every product MetaKocka currently holds appears in the result. Managed
 * products take Shopify's number; everything else is echoed back unchanged so
 * the endpoint's removal-by-omission behaviour cannot touch it.
 */
export function buildCompleteStockList(input: CompleteListInput): StockLine[] {
  const lines: StockLine[] = [];
  const seen = new Set<string>();

  for (const [productCode, amount] of input.managed) {
    lines.push({
      warehouseId: input.warehouseId,
      productCode,
      amount: Math.max(0, Math.trunc(amount)),
    });
    seen.add(productCode);
  }

  for (const [productCode, amount] of input.current) {
    if (seen.has(productCode)) continue;
    // Not ours to change, but it has to be present or MetaKocka removes it.
    lines.push({
      warehouseId: input.warehouseId,
      productCode,
      amount: Math.max(0, Math.trunc(amount)),
    });
  }

  return lines;
}

export interface SyncStockResult {
  sent: number;
  acknowledged: number;
}

export async function syncStockToMetakocka(
  credentials: MetakockaCredentials & { apiUserEmail: string },
  lines: StockLine[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SyncStockResult> {
  // Refusing an empty list is a safety rule, not a shortcut: an empty
  // `stock_list` is exactly the payload that would clear a warehouse.
  if (lines.length === 0) {
    throw new MetakockaError(
      "Refusing to sync an empty stock list: MetaKocka removes anything omitted from it",
      { endpoint: "sync_stock", kind: "exception" },
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(SYNC_STOCK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        secret_key: credentials.secretKey,
        company_id: credentials.companyId,
        api_user_email: credentials.apiUserEmail,
        stock_list: lines.map((line) => ({
          warehouse_id: line.warehouseId,
          product_code: line.productCode,
          amount: String(line.amount),
        })),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (cause) {
    throw new MetakockaError("MetaKocka sync_stock could not be reached", {
      endpoint: "sync_stock",
      kind: "retryable",
      cause,
    });
  }

  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new MetakockaError("MetaKocka sync_stock returned HTML, not JSON", {
      endpoint: "sync_stock",
      kind: "exception",
      httpStatus: response.status,
    });
  }

  const parsed = responseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new MetakockaError(
      "MetaKocka sync_stock returned an unrecognised response",
      { endpoint: "sync_stock", kind: "exception", cause: parsed.error },
    );
  }

  if (parsed.data.opr_code !== "0") {
    throw new MetakockaError(
      `MetaKocka sync_stock failed with opr_code ${parsed.data.opr_code}`,
      {
        endpoint: "sync_stock",
        kind: "exception",
        oprCode: parsed.data.opr_code,
        oprDesc: parsed.data.opr_desc,
      },
    );
  }

  // "Sync successful" is returned even when nothing was done, so success is
  // only believed if MetaKocka echoed back the lines that were sent.
  const acknowledged = parsed.data.stock_list?.length ?? 0;
  if (acknowledged !== lines.length) {
    throw new MetakockaError(
      `MetaKocka sync_stock reported success but acknowledged ${acknowledged} of ${lines.length} lines`,
      {
        endpoint: "sync_stock",
        kind: "exception",
        oprCode: parsed.data.opr_code,
        oprDesc: parsed.data.opr_desc,
      },
    );
  }

  getLogger().info(
    { sent: lines.length, acknowledged },
    "Stock written to MetaKocka",
  );

  return { sent: lines.length, acknowledged };
}
