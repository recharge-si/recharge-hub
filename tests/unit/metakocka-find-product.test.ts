import { describe, expect, it, vi } from "vitest";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { findProductByCode } from "~/adapters/metakocka/stock";

/**
 * Looking one article up by the code a merchant typed.
 *
 * This decides whether the order settings screen saves, so what is being
 * protected is the difference between "your catalogue does not have this" and
 * "I could not tell". `product_code_list` is verified on `warehouse_stock` and
 * only assumed on `product_list`, so a miss from the filtered call proves
 * nothing — and a merchant whose shipping article existed was refused by one.
 */

interface Row {
  mk_id: string;
  code: string;
  name?: string;
}

/** The page size the adapter reads the catalogue in. */
const PAGE = 500;

/**
 * A stand-in for the client that behaves like a catalogue: `filtered` is what
 * the `product_code_list` call answers, and everything else is paged.
 */
function catalogue({
  rows,
  filtered,
}: {
  rows: Row[];
  filtered: Row[];
}): { client: MetakockaClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];

  const call = vi.fn(
    async (
      _endpoint: string,
      body: Record<string, unknown>,
      schema: { parse: (value: unknown) => unknown },
    ) => {
      calls.push(body);

      if (body.product_code_list) {
        return schema.parse({ product_list: filtered });
      }

      const offset = Number(body.offset ?? 0);
      return schema.parse({ product_list: rows.slice(offset, offset + PAGE) });
    },
  );

  return { client: { call } as unknown as MetakockaClient, calls };
}

const SHIPPING = { mk_id: "1", code: "SHIPPING", name: "Postnina" };

describe("findProductByCode", () => {
  it("answers from the filtered call when the filter is applied", async () => {
    const { client, calls } = catalogue({
      rows: [SHIPPING],
      filtered: [SHIPPING],
    });

    expect(await findProductByCode(client, "SHIPPING")).toEqual({
      status: "found",
      product: { mkId: "1", code: "SHIPPING", name: "Postnina", type: null },
    });
    // One call, because the filter answered it.
    expect(calls).toHaveLength(1);
  });

  it("matches a code the merchant typed in another case, with spaces", async () => {
    const row = { mk_id: "1", code: "Shipping" };
    const { client } = catalogue({ rows: [row], filtered: [row] });

    expect((await findProductByCode(client, " SHIPPING ")).status).toBe(
      "found",
    );
  });

  it("reads the catalogue when the filtered call did not bring it back", async () => {
    const { client, calls } = catalogue({
      rows: [{ mk_id: "9", code: "OTHER" }, SHIPPING],
      filtered: [],
    });

    expect((await findProductByCode(client, "SHIPPING")).status).toBe("found");
    expect(calls.length).toBeGreaterThan(1);
  });

  it("says absent only once the whole catalogue has been read", async () => {
    const { client } = catalogue({
      rows: [{ mk_id: "9", code: "OTHER" }],
      filtered: [],
    });

    expect(await findProductByCode(client, "SHIPPING")).toEqual({
      status: "absent",
    });
  });

  it("says it does not know rather than absent when the catalogue runs long", async () => {
    const rows = Array.from({ length: PAGE * 12 }, (_, index) => ({
      mk_id: String(index),
      code: `P-${index}`,
    }));

    const { client } = catalogue({ rows, filtered: [] });

    expect(await findProductByCode(client, "SHIPPING")).toEqual({
      status: "unknown",
    });
  });

  it("does not call MetaKocka for an empty code", async () => {
    const { client, calls } = catalogue({ rows: [SHIPPING], filtered: [] });

    expect(await findProductByCode(client, "   ")).toEqual({
      status: "absent",
    });
    expect(calls).toHaveLength(0);
  });
});
