import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MetakockaClient } from "~/adapters/metakocka/client";
import { MetakockaError } from "~/adapters/metakocka/errors";
import { listWarehouses } from "~/adapters/metakocka/warehouses";

import warehouseListFixture from "../fixtures/metakocka/warehouse_list.json";

const CREDENTIALS = { companyId: "16", secretKey: "super-secret-key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return new MetakockaClient(CREDENTIALS, { fetchImpl, timeoutMs: 1000 });
}

const passthrough = z.object({}).passthrough();

/** Runs a call that is expected to fail and returns the MetakockaError. */
async function expectFailure(promise: Promise<unknown>): Promise<MetakockaError> {
  const error = await promise.then(
    () => new Error("expected the call to fail"),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MetakockaError);
  return error as MetakockaError;
}

describe("MetaKocka client", () => {
  it("posts the credentials in the body of every call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ opr_code: "0" }));
    await clientWith(fetchImpl as unknown as typeof fetch).call(
      "warehouse_list",
      {},
      passthrough,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];

    expect(url).toBe(
      "https://main.metakocka.si/rest/eshop/v1/json/warehouse_list",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      secret_key: "super-secret-key",
      company_id: "16",
    });
  });

  it("treats a non-zero opr_code as a business exception, not a retry", async () => {
    // No list of codes is documented, so an unknown failure must reach a human
    // rather than loop in the queue forever (CLAUDE.md section 11).
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        opr_code: "1",
        opr_desc: "Profit center 'Partner1' does not exist",
      }),
    );

    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .call("put_document", {}, passthrough)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MetakockaError);
    const mkError = error as MetakockaError;
    expect(mkError.kind).toBe("exception");
    expect(mkError.isRetryable).toBe(false);
    expect(mkError.oprCode).toBe("1");
    expect(mkError.oprDesc).toContain("Partner1");
  });

  it("treats a 500 as retryable", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(error.kind).toBe("retryable");
    expect(error.httpStatus).toBe(500);
  });

  it("treats a 429 as retryable", async () => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 }));
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(error.kind).toBe("retryable");
  });

  it("treats a 403 as an exception", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(error.kind).toBe("exception");
  });

  it("treats a transport failure as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(error.kind).toBe("retryable");
  });

  it("treats a 200 that is not JSON as an exception", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>maintenance</html>", { status: 200 }),
    );
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(error.kind).toBe("exception");
  });

  it("refuses a success payload that does not match its schema", async () => {
    // Section 3: no raw MetaKocka value reaches domain code.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ opr_code: "0", warehouse_list: "not an array" }),
    );

    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call(
        "warehouse_list",
        {},
        z.object({ warehouse_list: z.array(z.object({})) }),
      ),
    );

    expect(error.kind).toBe("exception");
    expect(error.message).toContain("did not match its schema");
  });

  it("never puts the secret key in the error it throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const error = await expectFailure(
      clientWith(fetchImpl as unknown as typeof fetch)
        .call("warehouse_list", {}, passthrough),
    );

    expect(JSON.stringify({ m: error.message, d: error.oprDesc })).not.toContain(
      "super-secret-key",
    );
  });
});

describe("warehouse_list", () => {
  it("maps the documented response onto the app's own shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(warehouseListFixture));
    const warehouses = await listWarehouses(
      clientWith(fetchImpl as unknown as typeof fetch),
    );

    expect(warehouses).toHaveLength(2);
    expect(warehouses[0]).toEqual({
      mkId: "678900000004",
      mark: "glavno",
      name: "Glavno skladišče",
      isMain: true,
      isActive: true,
      includeInStockInfo: true,
      warehouseType: "normal",
    });
    // Every string boolean is a real boolean by the time it leaves the adapter.
    expect(warehouses[1]!.isMain).toBe(false);
    expect(warehouses[1]!.isActive).toBe(true);
    // The live response omits show_product_free_stock and default_microloc_id
    // entirely, and country only on some rows: field presence varies per record.
    expect(warehouses[1]!.mark).toBe("Shopify");
  });

  it("returns an empty list rather than throwing when there are no warehouses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ opr_code: "0" }));
    const warehouses = await listWarehouses(
      clientWith(fetchImpl as unknown as typeof fetch),
    );

    expect(warehouses).toEqual([]);
  });
});
