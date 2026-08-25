import { describe, expect, it, vi } from "vitest";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { observeCatalogue } from "~/adapters/metakocka/pricelists";

/**
 * Reading pricelists off the catalogue is the only way to see them at all
 * (CLAUDE.md §3 has no endpoint), so what matters here is that it reads what is
 * there and never invents what is not: no pricelist the response did not name,
 * and no net-or-gross verdict the entries did not support.
 *
 * The shapes below are the recorded one from company 6789, which nests a bare
 * `price_def` object rather than the array `product_add` documents.
 */

/** A stand-in for the client, so nothing here touches a live company. */
function clientReturning(pages: unknown[]): {
  client: MetakockaClient;
  calls: { body: Record<string, unknown> }[];
} {
  const calls: { body: Record<string, unknown> }[] = [];
  let page = 0;

  const call = vi.fn(
    async (
      _endpoint: string,
      body: Record<string, unknown>,
      schema: { parse: (value: unknown) => unknown },
    ) => {
      calls.push({ body });
      return schema.parse(pages[page++] ?? { product_list: [] });
    },
  );

  return { client: { call } as unknown as MetakockaClient, calls };
}

const PRICED = {
  product_list: [
    {
      code: "P-1",
      pricelist: [
        {
          count_code: "1",
          title: "Shopify Pricelist",
          price_def: { tax: "EX4", tax_desc: "22", price: "171,31" },
        },
      ],
    },
    {
      code: "P-2",
      pricelist: [
        {
          count_code: "2",
          title: "Retail",
          price_def: [{ tax_desc: "9,5", price_with_tax: "21,90" }],
        },
      ],
    },
  ],
};

describe("reading pricelists off the catalogue", () => {
  it("collects the code, the title and the basis", async () => {
    const { client } = clientReturning([PRICED]);
    const observed = await observeCatalogue(client);

    expect(observed.pricelists).toEqual([
      {
        code: "1",
        title: "Shopify Pricelist",
        // The entry carries `price`, so the pricelist is net.
        includesTax: false,
      },
      { code: "2", title: "Retail", includesTax: true },
    ]);
  });

  it("asks for the pricelist, which the response omits without it", async () => {
    const { client, calls } = clientReturning([PRICED]);
    await observeCatalogue(client);

    expect(calls[0]?.body).toMatchObject({ return_pricelist: "true" });
  });

  it("normalises the rates so one rate is one suggestion", async () => {
    const { client } = clientReturning([
      {
        product_list: [
          {
            pricelist: [
              { count_code: "1", price_def: { tax_desc: "22", price: "1" } },
            ],
          },
          {
            pricelist: [
              { count_code: "1", price_def: { tax_desc: "22.00", price: "2" } },
            ],
          },
          {
            pricelist: [
              { count_code: "1", price_def: { tax_desc: "9,5", price: "3" } },
            ],
          },
        ],
      },
    ]);

    expect((await observeCatalogue(client)).taxPercents).toEqual(["9.5", "22"]);
  });

  it("says nothing about the basis when the entries do not agree", async () => {
    const { client } = clientReturning([
      {
        product_list: [
          {
            pricelist: [
              {
                count_code: "1",
                price_def: [{ price: "1" }, { price_with_tax: "2" }],
              },
            ],
          },
        ],
      },
    ]);

    const [only] = (await observeCatalogue(client)).pricelists;
    expect(only?.includesTax).toBeNull();
  });

  it("ignores a rate that is not a percentage rather than offering it", async () => {
    const { client } = clientReturning([
      {
        product_list: [
          {
            pricelist: [
              {
                count_code: "1",
                price_def: { tax_desc: "not a rate", price: "1" },
              },
            ],
          },
        ],
      },
    ]);

    expect((await observeCatalogue(client)).taxPercents).toEqual([]);
  });

  it("finds nothing in a catalogue with no prices, and does not guess", async () => {
    const { client } = clientReturning([
      { product_list: [{ code: "P-1" }, { code: "P-2" }] },
    ]);
    const observed = await observeCatalogue(client);

    expect(observed.pricelists).toEqual([]);
    expect(observed.taxPercents).toEqual([]);
  });

  it("stops once a page comes back short rather than paging forever", async () => {
    const { client, calls } = clientReturning([PRICED]);
    await observeCatalogue(client);

    expect(calls).toHaveLength(1);
  });
});
