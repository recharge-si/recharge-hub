import { describe, expect, it, vi } from "vitest";

import { MetakockaError } from "~/adapters/metakocka/errors";
import {
  buildCompleteStockList,
  syncStockToMetakocka,
} from "~/adapters/metakocka/sync-stock";

const CREDENTIALS = {
  companyId: "16",
  secretKey: "secret",
  apiUserEmail: "api@example.test",
};

describe("building the stock list for sync_stock", () => {
  it("takes Shopify's number for products this app manages", () => {
    const lines = buildCompleteStockList({
      warehouseId: "W1",
      managed: new Map([["SKU-A", 7]]),
      current: new Map([["SKU-A", 3]]),
    });

    expect(lines).toEqual([
      { warehouseId: "W1", productCode: "SKU-A", amount: 7 },
    ]);
  });

  it("preserves products it does not manage, because omission removes them", () => {
    // MetaKocka removes anything left out of the list. A product we know
    // nothing about must still be sent, at the value MetaKocka already holds.
    const lines = buildCompleteStockList({
      warehouseId: "W1",
      managed: new Map([["SKU-A", 7]]),
      current: new Map([
        ["SKU-A", 3],
        ["SKU-UNMANAGED", 42],
      ]),
    });

    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual({
      warehouseId: "W1",
      productCode: "SKU-UNMANAGED",
      amount: 42,
    });
  });

  it("never drops a product that MetaKocka currently holds", () => {
    const current = new Map([
      ["A", 1],
      ["B", 2],
      ["C", 3],
    ]);
    const lines = buildCompleteStockList({
      warehouseId: "W1",
      managed: new Map([["B", 99]]),
      current,
    });

    for (const code of current.keys()) {
      expect(lines.some((line) => line.productCode === code)).toBe(true);
    }
  });

  it("includes a managed product that MetaKocka has never seen", () => {
    const lines = buildCompleteStockList({
      warehouseId: "W1",
      managed: new Map([["NEW", 5]]),
      current: new Map(),
    });

    expect(lines).toEqual([
      { warehouseId: "W1", productCode: "NEW", amount: 5 },
    ]);
  });

  it("floors negatives to zero rather than sending them", () => {
    const lines = buildCompleteStockList({
      warehouseId: "W1",
      managed: new Map([["A", -4]]),
      current: new Map(),
    });

    expect(lines[0]!.amount).toBe(0);
  });
});

describe("syncStockToMetakocka", () => {
  it("refuses an empty list outright", async () => {
    // An empty stock_list is the payload that clears a warehouse.
    const fetchImpl = vi.fn();

    await expect(
      syncStockToMetakocka(CREDENTIALS, [], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(MetakockaError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a success that acknowledged fewer lines than were sent", async () => {
    // Verified against a live company: posting without a stock_list returns
    // opr_code 0 "Sync successful" having done nothing. Success is only
    // believed when MetaKocka echoes back what it was given.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            opr_code: "0",
            opr_desc: "Sync successful",
            stock_list: [{ product_code: "A", amount: "1" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const lines = [
      { warehouseId: "W1", productCode: "A", amount: 1 },
      { warehouseId: "W1", productCode: "B", amount: 2 },
    ];

    const error = await syncStockToMetakocka(CREDENTIALS, lines, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MetakockaError);
    expect((error as MetakockaError).message).toContain("acknowledged 1 of 2");
  });

  it("accepts a response that acknowledges every line", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            opr_code: "0",
            stock_list: [
              { product_code: "A", amount: "1" },
              { product_code: "B", amount: "2" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await syncStockToMetakocka(
      CREDENTIALS,
      [
        { warehouseId: "W1", productCode: "A", amount: 1 },
        { warehouseId: "W1", productCode: "B", amount: 2 },
      ],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result).toEqual({ sent: 2, acknowledged: 2 });
  });

  it("sends the api user email, which the secret key does not carry", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            opr_code: "0",
            stock_list: [{ product_code: "A" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await syncStockToMetakocka(
      CREDENTIALS,
      [{ warehouseId: "W1", productCode: "A", amount: 1 }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const [, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      api_user_email: "api@example.test",
      stock_list: [{ warehouse_id: "W1", product_code: "A", amount: "1" }],
    });
  });

  it("treats a non-zero opr_code as an exception", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ opr_code: "6", opr_desc: "Cannot find email" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const error = await syncStockToMetakocka(
      CREDENTIALS,
      [{ warehouseId: "W1", productCode: "A", amount: 1 }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    expect((error as MetakockaError).kind).toBe("exception");
  });
});
