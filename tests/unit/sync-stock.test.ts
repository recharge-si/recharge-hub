import { describe, expect, it, vi } from "vitest";

import { MetakockaError } from "~/adapters/metakocka/errors";
import {
  buildCompleteCompanyStockList,
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

  /*
   * The clamp belongs to the managed branch alone. Applying it to the echo
   * turns the write that exists to protect an unmanaged product into the one
   * that changes it — 3.5 restated as 3, -2 as 0 — which is precisely the
   * destructive write §7 is guarding against.
   */
  describe("the echo of a product this app does not manage", () => {
    it("keeps a fractional held value exactly", () => {
      const lines = buildCompleteStockList({
        warehouseId: "W1",
        managed: new Map([["A", 7]]),
        current: new Map([["LOOSE-CABLE-M", 3.5]]),
      });

      expect(lines).toContainEqual({
        warehouseId: "W1",
        productCode: "LOOSE-CABLE-M",
        amount: 3.5,
      });
    });

    it("keeps a negative held value exactly", () => {
      const lines = buildCompleteStockList({
        warehouseId: "W1",
        managed: new Map([["A", 7]]),
        current: new Map([["OVERSOLD", -2]]),
      });

      expect(lines).toContainEqual({
        warehouseId: "W1",
        productCode: "OVERSOLD",
        amount: -2,
      });
    });

    it("survives the request body as the same number", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              opr_code: "0",
              stock_list: [
                { product_code: "A", amount: "7" },
                { product_code: "LOOSE-CABLE-M", amount: "3.5" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await syncStockToMetakocka(
        CREDENTIALS,
        buildCompleteStockList({
          warehouseId: "W1",
          managed: new Map([["A", 7]]),
          current: new Map([["LOOSE-CABLE-M", 3.5]]),
        }),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );

      const [, init] = fetchImpl.mock.calls[0]! as unknown as [
        string,
        RequestInit,
      ];
      expect(JSON.parse(String(init.body))).toMatchObject({
        stock_list: [
          { product_code: "A", amount: "7" },
          { product_code: "LOOSE-CABLE-M", amount: "3.5" },
        ],
      });
    });
  });
});

describe("building the company-wide stock list for sync_stock", () => {
  // MetaKocka's own documentation for this endpoint says the total stock for
  // *all* warehouses must be sent in one request, and that anything absent
  // from it is removed. Sending lines for the reverse-synced warehouse alone
  // would, on that reading, wipe every other warehouse in the company.
  it("preserves lines from warehouses this app is not reverse-syncing", () => {
    const lines = buildCompleteCompanyStockList({
      warehouseId: "W1",
      managed: new Map([["A", 7]]),
      currentByWarehouse: new Map([
        ["W1", new Map([["A", 3]])],
        ["W2", new Map([["A", 9], ["B", 5]])],
      ]),
    });

    expect(lines).toContainEqual({ warehouseId: "W1", productCode: "A", amount: 7 });
    expect(lines).toContainEqual({ warehouseId: "W2", productCode: "A", amount: 9 });
    expect(lines).toContainEqual({ warehouseId: "W2", productCode: "B", amount: 5 });
  });

  it("still applies Shopify's number only at the reverse-synced warehouse", () => {
    const lines = buildCompleteCompanyStockList({
      warehouseId: "W1",
      managed: new Map([["A", 7]]),
      currentByWarehouse: new Map([
        ["W1", new Map([["A", 3]])],
        ["W2", new Map([["A", 3]])],
      ]),
    });

    expect(lines).toContainEqual({ warehouseId: "W1", productCode: "A", amount: 7 });
    // Same product code, a warehouse this source has no say over: untouched.
    expect(lines).toContainEqual({ warehouseId: "W2", productCode: "A", amount: 3 });
  });

  it("still includes a managed product at a warehouse MetaKocka has never held stock in", () => {
    const lines = buildCompleteCompanyStockList({
      warehouseId: "NEW-WH",
      managed: new Map([["A", 5]]),
      currentByWarehouse: new Map([["W2", new Map([["B", 1]])]]),
    });

    expect(lines).toContainEqual({
      warehouseId: "NEW-WH",
      productCode: "A",
      amount: 5,
    });
    expect(lines).toContainEqual({
      warehouseId: "W2",
      productCode: "B",
      amount: 1,
    });
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

  /*
   * §7: a no-op reports success. The count alone does not prove the write
   * happened — a right-length list of the wrong products passes it.
   */
  describe("checking the echo against what was sent", () => {
    const respondWith = (body: unknown) =>
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

    const LINES = [
      { warehouseId: "W1", productCode: "A", amount: 1 },
      { warehouseId: "W1", productCode: "B", amount: 2 },
    ];

    it("rejects a right-length echo naming the wrong products", async () => {
      const fetchImpl = respondWith({
        opr_code: "0",
        stock_list: [
          { product_code: "A", amount: "1" },
          { product_code: "SOMETHING-ELSE", amount: "2" },
        ],
      });

      const error = await syncStockToMetakocka(CREDENTIALS, LINES, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MetakockaError);
      expect((error as MetakockaError).message).toContain(
        "B was sent but not acknowledged",
      );
    });

    it("rejects an echo that came back at a different amount", async () => {
      const fetchImpl = respondWith({
        opr_code: "0",
        stock_list: [
          { product_code: "A", amount: "1" },
          { product_code: "B", amount: "0" },
        ],
      });

      const error = await syncStockToMetakocka(CREDENTIALS, LINES, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).catch((e: unknown) => e);

      expect((error as MetakockaError).message).toContain(
        "B was sent as 2 but came back as 0",
      );
    });

    it("does not invent a mismatch out of a field MetaKocka omits", async () => {
      // "Could not tell" is the safe direction to be wrong in: the
      // alternative raises an exception on every successful write.
      const fetchImpl = respondWith({
        opr_code: "0",
        stock_list: [{ product_code: "A" }, { product_code: "B" }],
      });

      await expect(
        syncStockToMetakocka(CREDENTIALS, LINES, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).resolves.toEqual({ sent: 2, acknowledged: 2 });
    });
  });

  describe("a response that is not a result", () => {
    it("classifies a 5xx as retryable", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("upstream is down", { status: 503 }),
      );

      const error = await syncStockToMetakocka(
        CREDENTIALS,
        [{ warehouseId: "W1", productCode: "A", amount: 1 }],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MetakockaError);
      expect((error as MetakockaError).kind).toBe("retryable");
    });

    it("classifies a 4xx as an exception", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("no", { status: 403 }),
      );

      const error = await syncStockToMetakocka(
        CREDENTIALS,
        [{ warehouseId: "W1", productCode: "A", amount: 1 }],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ).catch((e: unknown) => e);

      expect((error as MetakockaError).kind).toBe("exception");
    });

    it("does not let a body that is not JSON escape as a SyntaxError", async () => {
      // A raw SyntaxError reaches pg-boss unclassified and is retried as
      // though it were transient. It is not.
      const fetchImpl = vi.fn(
        async () =>
          new Response("not json at all", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      const error = await syncStockToMetakocka(
        CREDENTIALS,
        [{ warehouseId: "W1", productCode: "A", amount: 1 }],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MetakockaError);
      expect((error as MetakockaError).kind).toBe("exception");
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

  it("treats a non-empty stock_remove_list as a failure, not a quiet success", async () => {
    // The endpoint's own documentation: an item absent from the request is
    // removed and comes back listed here. The adapter's whole premise is
    // that the list it sends is complete, so this should never be non-empty
    // — and if it is, real stock was just dropped by a write that already
    // happened.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            opr_code: "0",
            stock_list: [{ product_code: "A", amount: "1" }],
            stock_remove_list: [{ product_code: "GONE" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const error = await syncStockToMetakocka(
      CREDENTIALS,
      [{ warehouseId: "W1", productCode: "A", amount: 1 }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MetakockaError);
    expect((error as MetakockaError).message).toContain("removed 1 item");
  });

  describe("matching the echo across more than one warehouse", () => {
    it("matches by (warehouse_id, product_code) when the same code is sent to two warehouses", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              opr_code: "0",
              stock_list: [
                { warehouse_id: "W1", product_code: "A", amount: "7" },
                { warehouse_id: "W2", product_code: "A", amount: "9" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await expect(
        syncStockToMetakocka(
          CREDENTIALS,
          [
            { warehouseId: "W1", productCode: "A", amount: 7 },
            { warehouseId: "W2", productCode: "A", amount: 9 },
          ],
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).resolves.toEqual({ sent: 2, acknowledged: 2 });
    });

    it("catches a real amount mismatch even with the same code in two warehouses", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              opr_code: "0",
              stock_list: [
                { warehouse_id: "W1", product_code: "A", amount: "7" },
                // W2's line came back wrong.
                { warehouse_id: "W2", product_code: "A", amount: "0" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const error = await syncStockToMetakocka(
        CREDENTIALS,
        [
          { warehouseId: "W1", productCode: "A", amount: 7 },
          { warehouseId: "W2", productCode: "A", amount: 9 },
        ],
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ).catch((e: unknown) => e);

      expect((error as MetakockaError).message).toContain(
        "A was sent as 9 but came back as 0",
      );
    });

    it("does not invent a mismatch when the same code in two warehouses echoes back without a warehouse_id", async () => {
      // Every fixture recorded against a live company so far has omitted
      // warehouse_id from the echo. With the same code sent to two
      // warehouses, an unwarehoused echo cannot say which one it answers
      // for — "could not tell" applies rather than a false alarm.
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              opr_code: "0",
              stock_list: [
                { product_code: "A", amount: "7" },
                { product_code: "A", amount: "9" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await expect(
        syncStockToMetakocka(
          CREDENTIALS,
          [
            { warehouseId: "W1", productCode: "A", amount: 7 },
            { warehouseId: "W2", productCode: "A", amount: 9 },
          ],
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).resolves.toEqual({ sent: 2, acknowledged: 2 });
    });
  });
});
