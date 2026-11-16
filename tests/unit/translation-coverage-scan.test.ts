import { describe, expect, it, vi } from "vitest";

import type { ResourcePage } from "~/adapters/shopify/translations";
import type { ResourceType } from "~/domain/translations/types";

/**
 * The store-wide count (docs/translations.md § Coverage): one type Shopify
 * refuses costs that type, not the count, and a type that fails mid-way
 * leaves nothing of itself behind.
 */
const pages = new Map<string, Array<ResourcePage | Error>>();

vi.mock("~/adapters/shopify/translations", () => ({
  readTranslatableResources: async (
    _admin: unknown,
    input: { type: ResourceType; after: string | null },
  ): Promise<ResourcePage> => {
    const queue = pages.get(input.type) ?? [];
    const next = queue.shift();
    if (next === undefined)
      return {
        resources: [],
        cursors: [],
        hasNextPage: false,
        endCursor: null,
      };
    if (next instanceof Error) throw next;
    return next;
  },
}));

const { scanCoverage, describeUnread, readCoverageChunk } =
  await import("~/adapters/translations/coverage.server");

function page(
  type: string,
  ids: string[],
  hasNextPage: boolean,
  translated: string[] = [],
): ResourcePage {
  return {
    hasNextPage,
    endCursor: hasNextPage ? `${type}:${ids.at(-1)}` : null,
    cursors: ids.map((id) => `${type}:${id}`),
    resources: ids.map((id) => ({
      resourceId: id,
      sourceLocale: null,
      fields: [
        { key: "title", value: `Title ${id}`, digest: "d", type: "STRING" },
      ],
      translations: new Map([
        [
          "sl",
          translated.includes(id)
            ? [
                {
                  key: "title",
                  value: "Naslov",
                  outdated: false,
                  updatedAt: null,
                },
              ]
            : [],
        ],
      ]),
    })),
  };
}

describe("scanCoverage", () => {
  it("counts every type it can read and names the ones it cannot", async () => {
    pages.clear();
    pages.set("PRODUCT", [
      page("PRODUCT", ["p1", "p2"], true, ["p1"]),
      page("PRODUCT", ["p3"], false),
    ]);
    pages.set("COLLECTION", [
      new Error("Access denied for translatableResources field."),
    ]);
    pages.set("PAGE", [page("PAGE", ["g1"], false, ["g1"])]);

    const scan = await scanCoverage({} as never, {
      types: ["PRODUCT", "COLLECTION", "PAGE"],
      locales: ["sl"],
    });

    expect(scan.rows).toEqual([
      expect.objectContaining({
        locale: "sl",
        resourceType: "PAGE",
        resources: 1,
        fields: 1,
        translated: 1,
        missing: 0,
      }),
      expect.objectContaining({
        locale: "sl",
        resourceType: "PRODUCT",
        resources: 3,
        fields: 3,
        translated: 1,
        missing: 2,
      }),
    ]);
    expect(scan.unread).toEqual([
      {
        type: "COLLECTION",
        reason: "Access denied for translatableResources field.",
      },
    ]);
    expect(describeUnread(scan.unread)).toBe(
      "Collection: Access denied for translatableResources field.",
    );
  });

  it("keeps nothing of a type that failed after its first page", async () => {
    pages.clear();
    pages.set("PRODUCT", [
      page("PRODUCT", ["p1"], true),
      new Error("Throttled"),
    ]);
    pages.set("PAGE", [page("PAGE", ["g1"], false)]);

    const scan = await scanCoverage({} as never, {
      types: ["PRODUCT", "PAGE"],
      locales: ["sl"],
    });

    expect(scan.rows.map((row) => row.resourceType)).toEqual(["PAGE"]);
    expect(scan.unread).toEqual([{ type: "PRODUCT", reason: "Throttled" }]);
  });

  it("reads nothing when there is no language to count for", async () => {
    pages.clear();
    pages.set("PRODUCT", [new Error("must not be called")]);
    await expect(
      scanCoverage({} as never, { types: ["PRODUCT"], locales: [] }),
    ).resolves.toEqual({ rows: [], unread: [] });
  });
});

describe("readCoverageChunk", () => {
  it("stops after its pages and carries the counts to the next pass", async () => {
    pages.clear();
    pages.set("PRODUCT", [
      page("PRODUCT", ["p1", "p2"], true, ["p1"]),
      page("PRODUCT", ["p3"], false),
    ]);
    const admin = {} as Parameters<typeof readCoverageChunk>[0];
    const first = await readCoverageChunk(admin, {
      type: "PRODUCT",
      after: null,
      locales: ["sl"],
      carried: [],
      maxPages: 1,
      pageSize: 2,
    });
    expect(first).toMatchObject({ read: 2, done: false, after: "PRODUCT:p2" });

    const second = await readCoverageChunk(admin, {
      type: "PRODUCT",
      after: first.after,
      locales: ["sl"],
      carried: first.rows,
      maxPages: 1,
      pageSize: 2,
    });
    expect(second).toMatchObject({ read: 1, done: true, after: null });
    expect(second.rows).toEqual([
      expect.objectContaining({
        locale: "sl",
        resourceType: "PRODUCT",
        resources: 3,
        fields: 3,
        translated: 1,
        missing: 2,
      }),
    ]);
  });
});
