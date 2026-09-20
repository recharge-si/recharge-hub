import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { describe, expect, it } from "vitest";

import { ContextSource } from "~/adapters/translations/context.server";
import { lookupKeys } from "~/adapters/translations/intelligence.server";
import { WATERSPORTS_MENU } from "../fixtures/translations/snapshots";

/**
 * Placing resources in the store from Shopify's answers
 * (docs/translations.md § Resource context): menus are read once per
 * pass, every link finds its siblings, products and collections their
 * facts, and a resource Shopify knows nothing about translates without.
 */

const menusReply = {
  data: {
    menus: {
      nodes: [
        {
          id: "gid://shopify/Menu/1",
          handle: "main-menu",
          title: "Main menu",
          items: WATERSPORTS_MENU.map((title, index) => ({
            id: `gid://shopify/MenuItem/${100 + index}`,
            title,
            type: "COLLECTION",
            resourceId: `gid://shopify/Collection/${index}`,
            items:
              title === "Wing"
                ? [
                    { id: "gid://shopify/MenuItem/201", title: "Wings", type: "COLLECTION", resourceId: null, items: [] },
                    { id: "gid://shopify/MenuItem/202", title: "Wing boards", type: "COLLECTION", resourceId: null, items: [] },
                  ]
                : [],
          })),
        },
        {
          id: "gid://shopify/Menu/2",
          handle: "footer",
          title: "Footer",
          items: [{ id: "gid://shopify/MenuItem/300", title: "Contact", type: "PAGE", resourceId: null, items: [] }],
        },
      ],
    },
  },
};

const nodesReply = {
  data: {
    nodes: [
      {
        __typename: "Product",
        id: "gid://shopify/Product/1",
        title: "Duotone Unit",
        vendor: "Duotone",
        productType: "Wing",
        tags: ["wing"],
        options: [{ id: "gid://shopify/ProductOption/1", name: "Size", optionValues: [{ id: "v1", name: "4.0" }] }],
        collections: { nodes: [{ title: "Wing" }, { title: "New" }] },
      },
      {
        __typename: "Collection",
        id: "gid://shopify/Collection/2",
        title: "Wing",
        productsCount: { count: 24 },
        products: { nodes: [{ title: "Duotone Unit" }, { title: "F-One Strike" }] },
      },
      { __typename: "Article", id: "gid://shopify/Article/3", title: "Bol", blog: { title: "Spot guide" } },
      {
        __typename: "Metafield",
        id: "gid://shopify/Metafield/4",
        namespace: "specs",
        key: "material",
        owner: { __typename: "Product", title: "Duotone Unit" },
        definition: { name: "Material", description: "Canopy material." },
      },
      null,
    ],
  },
};

function fakeAdmin(): { admin: AdminApiContext; calls: string[] } {
  const calls: string[] = [];
  const admin = {
    graphql: async (query: string) => {
      const name = /query\s+(\w+)/.exec(query)?.[1] ?? "unknown";
      calls.push(name);
      const body = name === "OrchestratorTranslationMenus" ? menusReply : nodesReply;
      return { json: async () => body } as Response;
    },
  } as unknown as AdminApiContext;
  return { admin, calls };
}

describe("ContextSource", () => {
  it("reads menus once and places every link among its siblings, by id or by title", async () => {
    const { admin, calls } = fakeAdmin();
    const source = new ContextSource(admin);
    await source.prime([
      { resourceId: "gid://shopify/Link/102", type: "LINK" },
      { resourceId: "gid://shopify/Link/103", type: "LINK" },
    ]);
    const wing = await source.contextFor("gid://shopify/Link/102", "LINK", "Wing");
    expect(wing).toEqual({
      kind: "menu_item",
      menuTitle: "Main menu",
      parents: [],
      siblings: WATERSPORTS_MENU,
      children: ["Wings", "Wing boards"],
      linksTo: "collection",
    });
    const child = await source.contextFor("gid://shopify/Link/202", "LINK", "Wing boards");
    expect(child).toMatchObject({ parents: ["Wing"], siblings: ["Wings", "Wing boards"], children: [] });
    // An id Shopify's menus do not carry falls back to a unique title.
    const byTitle = await source.contextFor("gid://shopify/Link/999", "LINK", "Contact");
    expect(byTitle).toMatchObject({ menuTitle: "Footer", linksTo: "page" });
    expect(await source.contextFor("gid://shopify/Link/998", "LINK", "Nowhere")).toEqual({ kind: "none" });
    const menu = await source.contextFor("gid://shopify/Menu/1", "MENU", "Main menu");
    expect(menu).toEqual({ kind: "menu", labels: WATERSPORTS_MENU });
    expect(calls.filter((call) => call === "OrchestratorTranslationMenus")).toHaveLength(1);
    expect(await source.neighbourText("gid://shopify/Link/102", "LINK", "Wing")).toEqual([
      ...WATERSPORTS_MENU.filter((label) => label !== "Wing"),
      "Wings",
      "Wing boards",
    ]);
  });

  it("reads the page's products, collections, articles and metafields in one request", async () => {
    const { admin, calls } = fakeAdmin();
    const source = new ContextSource(admin);
    await source.prime([
      { resourceId: "gid://shopify/Product/1", type: "PRODUCT" },
      { resourceId: "gid://shopify/Collection/2", type: "COLLECTION" },
      { resourceId: "gid://shopify/Article/3", type: "ARTICLE" },
      { resourceId: "gid://shopify/Metafield/4", type: "METAFIELD" },
      { resourceId: "gid://shopify/Page/5", type: "PAGE" },
    ]);
    expect(calls).toEqual(["OrchestratorTranslationContext"]);
    expect(await source.contextFor("gid://shopify/Product/1", "PRODUCT", "Duotone Unit")).toEqual({
      kind: "product",
      vendor: "Duotone",
      productType: "Wing",
      tags: ["wing"],
      collections: ["Wing", "New"],
      options: [{ name: "Size", values: ["4.0"] }],
    });
    expect(await source.contextFor("gid://shopify/Collection/2", "COLLECTION", "Wing")).toEqual({
      kind: "collection",
      productsCount: 24,
      sampleProducts: ["Duotone Unit", "F-One Strike"],
    });
    expect(await source.contextFor("gid://shopify/Article/3", "ARTICLE", "Bol")).toEqual({ kind: "article", blogTitle: "Spot guide" });
    expect(await source.contextFor("gid://shopify/Metafield/4", "METAFIELD", null)).toMatchObject({
      kind: "metafield",
      ownerKind: "product",
      ownerTitle: "Duotone Unit",
      definitionName: "Material",
    });
    expect(await source.contextFor("gid://shopify/Page/5", "PAGE", "About")).toEqual({ kind: "none" });
    // Priming again for known ids asks Shopify nothing more.
    await source.prime([{ resourceId: "gid://shopify/Product/1", type: "PRODUCT" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("lookupKeys", () => {
  it("asks memory for each whole field and every short phrase inside, bounded", () => {
    const keys = lookupKeys([
      { key: "title", value: "Duotone Wing Unit 4.0", digest: "d", type: "STRING" },
      { key: "body_html", value: "<p>For wing foiling.</p>", digest: "d", type: "HTML" },
    ]);
    expect(keys).toContain("duotone wing unit 4.0");
    expect(keys).toContain("wing");
    expect(keys).toContain("wing unit");
    expect(keys).toContain("wing foiling");
    expect(keys).not.toContain("4.0");
    const huge = lookupKeys([{ key: "b", value: Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" "), digest: "d", type: "STRING" }]);
    expect(huge.length).toBeLessThanOrEqual(400);
  });
});
