import { describe, expect, it, vi } from "vitest";

import { MetakockaClient } from "~/adapters/metakocka/client";
import { listWarehouseStock } from "~/adapters/metakocka/stock";

const CREDENTIALS = { companyId: "16", secretKey: "super-secret-key" };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return new MetakockaClient(CREDENTIALS, { fetchImpl, timeoutMs: 1000 });
}

describe("listWarehouseStock", () => {
  it("sums separate microlocation rows for the same warehouse and product into one", async () => {
    // Verified: a live company can return more than one row for the same
    // (warehouse_id, code) pair. A caller building a Map keyed by code alone
    // would have the second row silently overwrite the first.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        stock_list: [
          {
            warehouse_id: "W1",
            mk_id: "loc-a",
            code: "SKU-A",
            amount: "3",
            reserved_amount: "1",
          },
          {
            warehouse_id: "W1",
            mk_id: "loc-b",
            code: "SKU-A",
            amount: "4",
            reserved_amount: "2",
          },
        ],
      }),
    );

    const rows = await listWarehouseStock(
      clientWith(fetchImpl as unknown as typeof fetch),
      "W1",
    );

    expect(rows).toEqual([
      {
        warehouseId: "W1",
        code: "SKU-A",
        title: null,
        amount: 7,
        reserved: 3,
        free: 4,
      },
    ]);
  });

  it("drops rows for warehouses other than the one asked for", async () => {
    /*
     * The doubling bug. `wh_id_list` has never been proved to filter, and both
     * callers key this result by product code alone — so another warehouse's
     * row used to be folded in as though it were this warehouse's. The reverse
     * sync then sent every warehouse's map in one `sync_stock` request, and a
     * two-warehouse company had every product's total doubled.
     */
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        stock_list: [
          { warehouse_id: "W1", mk_id: "loc-a", code: "SKU-A", amount: "3" },
          { warehouse_id: "W2", mk_id: "loc-b", code: "SKU-A", amount: "5" },
          { warehouse_id: "W2", mk_id: "loc-b", code: "SKU-B", amount: "9" },
        ],
      }),
    );

    const rows = await listWarehouseStock(
      clientWith(fetchImpl as unknown as typeof fetch),
      "W1",
    );

    expect(rows).toEqual([
      {
        warehouseId: "W1",
        code: "SKU-A",
        title: null,
        amount: 3,
        reserved: 0,
        free: 3,
      },
    ]);
  });

  it("refuses a response that carries rows but none for this warehouse", async () => {
    // Not an empty warehouse — an empty warehouse answers with nothing at all.
    // It means the id this app holds is not the id MetaKocka answers with, and
    // an empty result would be read as “everything is at zero”.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        stock_list: [
          { warehouse_id: "W2", mk_id: "loc-b", code: "SKU-A", amount: "5" },
        ],
      }),
    );

    await expect(
      listWarehouseStock(
        clientWith(fetchImpl as unknown as typeof fetch),
        "W1",
      ),
    ).rejects.toThrow(/none of them for warehouse W1/);
  });

  it("returns nothing for a warehouse that genuinely holds nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ stock_list: [] }));

    await expect(
      listWarehouseStock(
        clientWith(fetchImpl as unknown as typeof fetch),
        "W1",
      ),
    ).resolves.toEqual([]);
  });

  it("falls back to amount minus reserved when a microlocation omits free_amount", async () => {
    // Summing free_amount across microlocations is only meaningful if every
    // row reported it; otherwise the aggregate is recomputed instead of
    // silently undercounting.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        stock_list: [
          {
            warehouse_id: "W1",
            mk_id: "loc-a",
            code: "SKU-A",
            amount: "3",
            reserved_amount: "1",
            free_amount: "2",
          },
          {
            warehouse_id: "W1",
            mk_id: "loc-b",
            code: "SKU-A",
            amount: "4",
            reserved_amount: "2",
          },
        ],
      }),
    );

    const rows = await listWarehouseStock(
      clientWith(fetchImpl as unknown as typeof fetch),
      "W1",
    );

    expect(rows).toEqual([
      {
        warehouseId: "W1",
        code: "SKU-A",
        title: null,
        amount: 7,
        reserved: 3,
        free: 4,
      },
    ]);
  });
});
