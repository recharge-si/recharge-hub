import { describe, expect, it, vi } from "vitest";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { addProduct, updateProduct } from "~/adapters/metakocka/products";
import { listProducts } from "~/adapters/metakocka/stock";

/**
 * Prodajni, Nabavni and Storitev — the three type flags a MetaKocka article
 * carries, and the only three the API can set (`docs/product_concept.md`).
 *
 * Two things are worth holding still. They go out as MetaKocka's own strings
 * rather than JSON booleans, because everything in this API is a string (§3).
 * And an update carries them only when the caller asked: §8.9 leaves MetaKocka
 * master for its own catalogue, and flipping the service flag on an article
 * already used on a document makes MetaKocka ask to recalculate stock.
 */
function recordingClient(response: unknown = { opr_code: 0 }): {
  client: MetakockaClient;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];

  const call = vi.fn(
    async (
      _endpoint: string,
      body: Record<string, unknown>,
      schema: { parse: (value: unknown) => unknown },
    ) => {
      bodies.push(body);
      return schema.parse(response);
    },
  );

  return { client: { call } as unknown as MetakockaClient, bodies };
}

describe("product type flags", () => {
  it("sends all three as strings when a product is created", async () => {
    const { client, bodies } = recordingClient();

    await addProduct(client, {
      countCode: "A-1",
      code: "A-1",
      name: "A shirt",
      type: { sales: true, purchasing: true, service: false },
    });

    expect(bodies[0]).toMatchObject({
      sales: "true",
      purchasing: "true",
      service: "false",
    });
  });

  it("creates a sales-only article when the caller says nothing", async () => {
    const { client, bodies } = recordingClient();

    await addProduct(client, { countCode: "A-1", code: "A-1", name: "A" });

    expect(bodies[0]).toMatchObject({
      sales: "true",
      purchasing: "false",
      service: "false",
    });
  });

  it("leaves an existing article's type alone unless asked", async () => {
    const { client, bodies } = recordingClient();

    await updateProduct(client, { mkId: "17", name: "A better name" });

    expect(bodies[0]).not.toHaveProperty("sales");
    expect(bodies[0]).not.toHaveProperty("purchasing");
    expect(bodies[0]).not.toHaveProperty("service");
  });

  it("never offers to recalculate stock on a service change", async () => {
    const { client, bodies } = recordingClient();

    await updateProduct(client, {
      mkId: "17",
      type: { sales: true, purchasing: false, service: true },
    });

    expect(bodies[0]).toMatchObject({ service: "true" });
    // MetaKocka's own confirmation parameter. Sending it would agree to a stock
    // recalculation on the merchant's books without asking them.
    expect(bodies[0]).not.toHaveProperty("confirm_save_change_product_service");
  });

  it("reads the flags back off the catalogue", async () => {
    const { client } = recordingClient({
      product_list: [
        {
          mk_id: "17",
          code: "A-1",
          name: "A shirt",
          sales: "true",
          purchasing: "true",
          service: "false",
        },
      ],
    });

    const [product] = await listProducts(client);

    expect(product?.type).toEqual({
      sales: true,
      purchasing: true,
      service: false,
    });
  });

  it("says it does not know rather than guessing false", async () => {
    const { client } = recordingClient({
      product_list: [{ mk_id: "17", code: "A-1", sales: "true" }],
    });

    const [product] = await listProducts(client);

    // An absent flag read as false would rewrite every article on every run.
    expect(product?.type).toBeNull();
  });
});
