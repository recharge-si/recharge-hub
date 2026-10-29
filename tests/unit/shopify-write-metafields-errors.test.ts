import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, it } from "vitest";

import { writeMetafields } from "~/adapters/shopify/product-workspace";

/**
 * A `metafieldsSet` refusal says which write of the call it concerns
 * (`["metafields", "1", "value"]`); the index is returned against the whole
 * list, across the 25-per-call batches, so the page can name the attribute.
 */

function write(i: number) {
  return {
    ownerId: "gid://shopify/Product/1",
    namespace: "recharge",
    key: `field_${i}`,
    type: "number_decimal",
    value: "1",
  };
}

describe("writeMetafields errors", () => {
  it("returns the position of the refused write across batches", async () => {
    let call = 0;
    const admin = {
      graphql: async () => {
        call += 1;
        return {
          json: async () => ({
            data: {
              metafieldsSet: {
                userErrors:
                  call === 2
                    ? [
                        {
                          field: ["metafields", "2", "value"],
                          message: "Value must be a decimal.",
                        },
                      ]
                    : [],
              },
            },
          }),
        };
      },
    } as unknown as AdminApiContext;
    const outcome = await writeMetafields(
      admin,
      Array.from({ length: 30 }, (_, i) => write(i)),
      [],
    );
    expect(outcome).toEqual({
      ok: false,
      errors: [
        { field: "value", message: "Value must be a decimal.", index: 27 },
      ],
    });
  });
});
