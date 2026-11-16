import { describe, expect, it } from "vitest";

import {
  ALL_CONTENT_GROUPS,
  removalScope,
  type ContentGroup,
  type KeepOriginal,
} from "~/domain/translations/types";

const settings = (
  contentScope: ContentGroup[] = [...ALL_CONTENT_GROUPS],
  keepOriginal: KeepOriginal[] = [],
) => ({ contentScope, keepOriginal });

describe("removalScope", () => {
  it("takes nothing away when nothing is switched off", () => {
    expect(removalScope(settings(), settings())).toEqual([]);
    expect(
      removalScope(settings(["products"], ["product_titles"]), settings()),
    ).toEqual([]);
  });

  it("takes a content group out of scope whole", () => {
    expect(removalScope(settings(), settings(["products", "pages"]))).toEqual([
      { type: "COLLECTION", keys: null },
      { type: "BLOG", keys: null },
      { type: "ARTICLE", keys: null },
      { type: "MENU", keys: null },
      { type: "LINK", keys: null },
      { type: "METAFIELD", keys: null },
      { type: "METAOBJECT", keys: null },
      { type: "SHOP", keys: null },
      { type: "SHOP_POLICY", keys: null },
      { type: "FILTER", keys: null },
      { type: "DELIVERY_METHOD_DEFINITION", keys: null },
      { type: "SELLING_PLAN", keys: null },
      { type: "SELLING_PLAN_GROUP", keys: null },
    ]);
  });

  it("takes a newly kept field, merged per type", () => {
    expect(
      removalScope(
        settings(undefined, ["product_types"]),
        settings(undefined, [
          "product_types",
          "product_titles",
          "product_options",
        ]),
      ),
    ).toEqual([
      { type: "PRODUCT", keys: ["title"] },
      { type: "PRODUCT_OPTION", keys: ["name"] },
      { type: "PRODUCT_OPTION_VALUE", keys: ["name"] },
    ]);
  });

  it("lets a whole type win over a kept field in it", () => {
    expect(
      removalScope(
        settings(["products", "collections"]),
        settings(["products"], ["collection_titles"]),
      ),
    ).toEqual([{ type: "COLLECTION", keys: null }]);
  });
});
