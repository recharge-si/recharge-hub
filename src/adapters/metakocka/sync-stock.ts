import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";
import {
  MetakockaError,
  classifyHttpStatus,
} from "~/adapters/metakocka/errors";
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
    // Per the endpoint's own documentation: items previously in stock but
    // absent from the request come back here, having been removed. The list
    // sent is meant to be complete, so a non-empty response here means it
    // was not — a real product this app does not manage, or a whole
    // warehouse, was left out and just lost its recorded stock.
    stock_remove_list: z
      .array(z.object({}).passthrough())
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
 * Shopify's number, in the form MetaKocka can be told to hold.
 *
 * Shopify counts in whole units and can report a negative on-hand (an
 * oversold location), which is a statement about Shopify's ledger rather than
 * a quantity a warehouse can contain. Exported so the caller deciding whether
 * anything changed compares the value that would actually be sent, not the
 * raw one — otherwise an on-hand of -1 against a held 0 looks like a change
 * for ever and files an inventory document every five minutes.
 */
export function managedAmount(amount: number): number {
  return Math.max(0, Math.trunc(amount));
}

/**
 * The full stock list for one warehouse.
 *
 * Every product MetaKocka currently holds appears in the result. Managed
 * products take Shopify's number; everything else is echoed back unchanged so
 * the endpoint's removal-by-omission behaviour cannot touch it.
 *
 * **The echo is verbatim, clamp included.** Rounding or flooring a held value
 * on the way past is the very write this list exists to prevent: a product
 * this app does not manage, standing at 3.5 or at -2 in the merchant's ERP,
 * would be silently restated as 3 or 0 by the act of protecting it. Only the
 * managed branch clamps, because only there is the number ours to state.
 */
export function buildCompleteStockList(input: CompleteListInput): StockLine[] {
  const lines: StockLine[] = [];
  const seen = new Set<string>();

  for (const [productCode, amount] of input.managed) {
    lines.push({
      warehouseId: input.warehouseId,
      productCode,
      amount: managedAmount(amount),
    });
    seen.add(productCode);
  }

  for (const [productCode, amount] of input.current) {
    if (seen.has(productCode)) continue;
    // Not ours to change, but it has to be present or MetaKocka removes it.
    lines.push({ warehouseId: input.warehouseId, productCode, amount });
  }

  return lines;
}

export interface CompanyListInput {
  /** What Shopify says, for the SKUs this app manages at the reverse-synced warehouse. */
  managed: Map<string, number>;
  /** The warehouse Shopify is the source of truth for. */
  warehouseId: string;
  /**
   * What MetaKocka currently holds, for every cached warehouse — not only
   * `warehouseId`. Keyed by warehouse id, then by product code.
   */
  currentByWarehouse: Map<string, Map<string, number>>;
}

/**
 * The full stock list for the whole company, across every cached warehouse.
 *
 * MetaKocka's own documentation for this endpoint (`warehouse_stock_sync`,
 * fetched 2026-08-26, not yet checked against the designated test company)
 * says plainly that "the total stock for all warehouses must be sent in one
 * request" and that an item absent from the request is removed from stock —
 * which reads as applying to a warehouse missing from the request altogether,
 * not only to a product missing within a warehouse that is present.
 * `buildCompleteStockList` alone sent lines for the reverse-synced warehouse
 * only, which on that reading would zero out every other warehouse in the
 * company on every write.
 *
 * The reverse-synced warehouse is built the same way `buildCompleteStockList`
 * always has: Shopify's number for managed products, MetaKocka's own value
 * echoed back verbatim for everything else. Every other cached warehouse is
 * echoed back verbatim in full — this app has no opinion about it, and the
 * only reason it appears in the request at all is that the endpoint requires
 * it to.
 */
export function buildCompleteCompanyStockList(
  input: CompanyListInput,
): StockLine[] {
  const lines: StockLine[] = [];

  for (const [warehouseId, current] of input.currentByWarehouse) {
    if (warehouseId === input.warehouseId) {
      lines.push(
        ...buildCompleteStockList({
          warehouseId,
          managed: input.managed,
          current,
        }),
      );
      continue;
    }

    for (const [productCode, amount] of current) {
      lines.push({ warehouseId, productCode, amount });
    }
  }

  // The reverse-synced warehouse might not yet be in `currentByWarehouse`
  // (MetaKocka has never held stock there) — still has to carry Shopify's
  // managed products, or they would never appear in the warehouse at all.
  if (!input.currentByWarehouse.has(input.warehouseId)) {
    lines.push(
      ...buildCompleteStockList({
        warehouseId: input.warehouseId,
        managed: input.managed,
        current: new Map(),
      }),
    );
  }

  return lines;
}

/**
 * A stock amount as a decimal string MetaKocka will read back as the same
 * number.
 *
 * `String()` switches to exponent notation past 1e21 and below 1e-7, which
 * MetaKocka would take as a different value entirely. No warehouse holds
 * either, so this only has to refuse to be silently wrong about it.
 */
function amountString(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new MetakockaError(
      `Refusing to send a stock amount that is not a finite number: ${String(amount)}`,
      { endpoint: "sync_stock", kind: "exception" },
    );
  }

  const text = String(amount);
  if (text.includes("e") || text.includes("E")) {
    throw new MetakockaError(
      `Refusing to send a stock amount MetaKocka would misread: ${text}`,
      { endpoint: "sync_stock", kind: "exception" },
    );
  }

  return text;
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
          amount: amountString(line.amount),
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

  // A 429 or a 5xx is worth retrying; a 4xx is a request that will fail the
  // same way next time. Without this the body of an error page was read as if
  // it were a result, and the classification the queue needs never happened.
  if (!response.ok) {
    throw new MetakockaError(
      `MetaKocka sync_stock returned HTTP ${response.status}`,
      {
        endpoint: "sync_stock",
        kind: classifyHttpStatus(response.status),
        httpStatus: response.status,
      },
    );
  }

  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new MetakockaError("MetaKocka sync_stock returned HTML, not JSON", {
      endpoint: "sync_stock",
      kind: "exception",
      httpStatus: response.status,
    });
  }

  // A raw SyntaxError out of here reaches pg-boss as an unclassified throw and
  // is retried as though it were transient. It is not: a 200 that is not JSON
  // fails identically on the next attempt.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new MetakockaError(
      "MetaKocka sync_stock returned a response that is not JSON",
      {
        endpoint: "sync_stock",
        kind: "exception",
        httpStatus: response.status,
        cause,
      },
    );
  }

  const parsed = responseSchema.safeParse(raw);
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
  const echoed = parsed.data.stock_list ?? [];
  const acknowledged = echoed.length;
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

  const mismatch = describeEchoMismatch(lines, echoed);
  if (mismatch) {
    throw new MetakockaError(
      `MetaKocka sync_stock reported success but the stock it echoed back does not match what was sent: ${mismatch}`,
      {
        endpoint: "sync_stock",
        kind: "exception",
        oprCode: parsed.data.opr_code,
        oprDesc: parsed.data.opr_desc,
      },
    );
  }

  // The list this adapter sends is meant to describe every warehouse
  // completely, so nothing should ever come back here. If something did, the
  // list was not actually complete and MetaKocka has just removed real stock
  // — treated as a failure rather than logged quietly, because the write
  // already happened and cannot be taken back from here.
  const removed = parsed.data.stock_remove_list ?? [];
  if (removed.length > 0) {
    throw new MetakockaError(
      `MetaKocka sync_stock removed ${removed.length} item(s) not present in the request — the stock list sent was not complete`,
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

type EchoedLine = NonNullable<
  z.infer<typeof responseSchema>["stock_list"]
>[number];

/**
 * The first way the echoed list disagrees with what was sent, or null.
 *
 * §7: a no-op reports success, so the count alone is not evidence — a right-
 * length list of the wrong products would pass it. What is checked is the set
 * of product codes and, where MetaKocka repeats the amount, the amount too.
 *
 * A field MetaKocka simply does not return is not treated as a disagreement.
 * "Could not tell" is the safe direction to be wrong in here: the alternative
 * raises an exception on every successful write the moment MetaKocka trims a
 * field from its response, and a queue full of false alarms is a queue nobody
 * reads (§11).
 *
 * Matched by `(warehouse_id, product_code)`, not product code alone, because
 * a company-wide write can legitimately send the same product code to more
 * than one warehouse. Where the echo omits `warehouse_id` — the shape every
 * fixture recorded so far has used — a code is still matched by itself as
 * long as it was only ever sent to one warehouse in this request; sent to
 * more than one, an unwarehoused echo cannot say which of them it answers
 * for, and "could not tell" applies rather than guessing.
 */
function describeEchoMismatch(
  sent: StockLine[],
  echoed: EchoedLine[],
): string | null {
  const named = echoed.filter((line) => line.product_code !== undefined);
  if (named.length === 0) return null;

  const exact = new Map<string, EchoedLine>();
  const byCodeUnwarehoused = new Map<string, EchoedLine>();
  for (const line of named) {
    const code = String(line.product_code);
    if (line.warehouse_id !== undefined) {
      exact.set(`${line.warehouse_id}:${code}`, line);
    } else if (!byCodeUnwarehoused.has(code)) {
      byCodeUnwarehoused.set(code, line);
    }
  }

  const warehousesByCode = new Map<string, Set<string>>();
  for (const line of sent) {
    const set = warehousesByCode.get(line.productCode) ?? new Set();
    set.add(line.warehouseId);
    warehousesByCode.set(line.productCode, set);
  }

  for (const line of sent) {
    const back =
      exact.get(`${line.warehouseId}:${line.productCode}`) ??
      (warehousesByCode.get(line.productCode)!.size === 1
        ? byCodeUnwarehoused.get(line.productCode)
        : undefined);

    if (!back) {
      // Ambiguous (sent to several warehouses, echo does not say which) is
      // silently skipped, not reported here — ambiguity is not evidence of
      // anything having gone wrong.
      if (warehousesByCode.get(line.productCode)!.size > 1) continue;
      return `${line.productCode} was sent but not acknowledged`;
    }
    if (back.amount === undefined) continue;
    // MetaKocka answers in decimal strings; mkDecimal has already made a
    // number of it. Compare with a tolerance rather than on equality, because
    // a half-cent of float noise is not a failed write.
    if (Math.abs(back.amount - line.amount) > 1e-6) {
      return `${line.productCode} was sent as ${amountString(line.amount)} but came back as ${String(back.amount)}`;
    }
  }

  return null;
}
