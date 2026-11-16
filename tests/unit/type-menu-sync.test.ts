import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeMenu from "~/adapters/shopify/type-menu";
import { starterSchema } from "~/domain/attributes/starter";

/**
 * docs/attributes.md § Store menu: the job writes changed product types,
 * makes or updates a collection per type, publishes only new ones, and
 * replaces the menu's items — finding what an earlier run made.
 */

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  patches: [] as Array<Record<string, unknown>>,
  alive: new Set<string>(),
  created: [] as string[],
  updated: [] as string[],
  published: [] as string[],
  menus: [] as Array<{ menuId: string | null; links: unknown }>,
  writes: [] as unknown[],
  fail: null as null | Error,
  legacyFails: false,
  legacyRemoved: 0,
  matched: [] as string[],
  extraProducts: [] as string[],
  recorded: [] as Array<{ productId: string; path: string[] | null }>,
  claimed: true,
  requeued: 0,
}));

vi.mock("~/adapters/shopify/shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: {} }) },
}));
vi.mock("~/adapters/db/repositories/attribute-schema.server", () => ({
  getAttributeSchema: async () => ({ schema: starterSchema(), revision: 1 }),
}));
vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: async () => undefined,
}));
vi.mock("~/adapters/db/repositories/type-menu.server", () => ({
  getTypeMenu: async () => state.row,
  updateTypeMenu: async (_: unknown, patch: Record<string, unknown>) => {
    state.patches.push(patch);
  },
  catalogueForMenu: async () =>
    ["p1", ...state.extraProducts].map((productId) => ({
      productId,
      productType: "Wave sails",
      categoryName: null,
      current: null,
    })),
  chosenTypes: async () => new Map(),
  recordTypeField: async (
    _: unknown,
    changes: Array<{ productId: string; path: string[] | null }>,
  ) => {
    state.recorded.push(...changes);
  },
  startTypeMenu: async () => ({ started: state.claimed }),
}));
vi.mock("~/adapters/products/type-menu-updates.server", () => ({
  queueTypeMenuUpdate: async () => {
    state.requeued++;
  },
}));
vi.mock("~/adapters/shopify/product-workspace", () => ({
  writeMetafields: async (_: unknown, writes: Array<{ ownerId: string }>) => {
    // Shopify refuses a whole call naming a deleted product.
    if (writes.some((w) => w.ownerId.startsWith("gone")))
      return {
        ok: false,
        errors: [{ field: "ownerId", message: "Owner does not exist." }],
      };
    state.writes.push(...writes);
    return { ok: true, errors: [] };
  },
}));
vi.mock("~/adapters/shopify/type-menu", async (original) => {
  const actual = await original<typeof TypeMenu>();
  return {
    TypeMenuError: actual.TypeMenuError,
    ensureTypeField: async () => {
      if (state.fail) throw state.fail;
      return "def-1";
    },
    existingCollections: async () => state.alive,
    onlineStorePublication: async () => "pub-online",
    removeLegacyTypeField: async () => {
      if (state.legacyFails) throw new Error("definition in use");
      state.legacyRemoved++;
    },
    publishCollection: async (_: unknown, id: string) => {
      state.published.push(id);
    },
    upsertTypeCollection: async (
      _: unknown,
      input: {
        existing: { collectionId: string } | null;
        title: string;
        typeId: string;
      },
    ) => {
      state.matched.push(input.typeId);
      if (input.existing) {
        state.updated.push(input.title);
        return { collectionId: input.existing.collectionId, sourceId: "s2" };
      }
      state.created.push(input.title);
      return { collectionId: `c-${input.title}`, sourceId: "s1" };
    },
    upsertMenu: async (
      _: unknown,
      input: { menuId: string | null; links: unknown },
    ) => {
      state.menus.push(input);
      return "menu-1";
    },
  };
});

const { handleTypeMenuSync } = await import("~/jobs/handlers/type-menu-sync");
const job = { data: { shopDomain: "shop.myshopify.com" } } as Job<unknown>;

beforeEach(() => {
  state.row = { collections: {}, menuId: null };
  state.patches = [];
  state.alive = new Set();
  state.created = [];
  state.updated = [];
  state.published = [];
  state.menus = [];
  state.writes = [];
  state.fail = null;
  state.legacyFails = false;
  state.extraProducts = [];
  state.legacyRemoved = 0;
  state.matched = [];
  state.recorded = [];
  state.claimed = true;
  state.requeued = 0;
});

describe("making the store menu", () => {
  it("writes types, makes and publishes a collection per type, then the menu", async () => {
    await handleTypeMenuSync(job);

    expect(state.writes).toEqual([
      expect.objectContaining({
        ownerId: "p1",
        type: "list.single_line_text_field",
        value: JSON.stringify(["all", "windsurf", "sails", "wave"]),
      }),
    ]);
    expect(state.created).toHaveLength(starterSchema().types.length);
    // One value per collection, whatever the size of the branch beneath.
    expect(state.matched).toEqual(starterSchema().types.map((t) => t.id));
    expect(state.legacyRemoved).toBe(1);
    expect(state.published).toHaveLength(starterSchema().types.length);
    expect(state.menus[0]?.links).toEqual([
      expect.objectContaining({
        title: "Windsurf",
        collectionId: "c-Windsurf",
        items: [
          expect.objectContaining({ title: "Sails" }),
          expect.objectContaining({ title: "Boards" }),
        ],
      }),
      expect.objectContaining({ title: "Clothing" }),
    ]);
    expect(state.patches.at(-1)).toMatchObject({
      status: "done",
      menuId: "menu-1",
      lastError: null,
    });
  });

  it("updates what it made before, remakes what was deleted, publishes only new", async () => {
    state.row = {
      menuId: "menu-1",
      collections: {
        sails: { collectionId: "c-old-sails", sourceId: "s0" },
        wave: { collectionId: "c-deleted", sourceId: "s0" },
      },
    };
    state.alive = new Set(["c-old-sails"]);

    await handleTypeMenuSync(job);

    expect(state.updated).toEqual(["Sails"]);
    expect(state.created).toContain("Wave sails");
    expect(state.published).not.toContain("c-old-sails");
    expect(state.menus[0]?.menuId).toBe("menu-1");
  });

  it("records what it wrote, so the next run writes only what moved", async () => {
    await handleTypeMenuSync(job);

    expect(state.recorded).toEqual([
      { productId: "p1", path: ["all", "windsurf", "sails", "wave"] },
    ]);
  });

  it("leaves a collection already titled as its type alone", async () => {
    state.row = {
      menuId: "menu-1",
      definitionId: "def-1",
      collections: {
        sails: { collectionId: "c-sails", sourceId: "s0", title: "Sails" },
        boards: { collectionId: "c-boards", sourceId: "s0", title: "Old" },
      },
    };
    state.alive = new Set(["c-sails", "c-boards"]);

    await handleTypeMenuSync(job);

    expect(state.matched).not.toContain("sails");
    expect(state.updated).toEqual(["Boards"]);
    expect(state.patches.at(-1)).toMatchObject({
      collections: expect.objectContaining({
        sails: expect.objectContaining({ collectionId: "c-sails" }),
        boards: expect.objectContaining({ title: "Boards" }),
      }),
    });
  });

  it("rewrites every collection when the type field was made again", async () => {
    state.row = {
      menuId: "menu-1",
      definitionId: "def-old",
      collections: {
        sails: { collectionId: "c-sails", sourceId: "s0", title: "Sails" },
      },
    };
    state.alive = new Set(["c-sails"]);

    await handleTypeMenuSync(job);

    expect(state.updated).toEqual(["Sails"]);
  });

  it("does nothing automatically before the menu has been made", async () => {
    await handleTypeMenuSync({
      data: { shopDomain: "shop.myshopify.com", automatic: true },
    } as Job<unknown>);

    expect(state.patches).toEqual([]);
    expect(state.menus).toEqual([]);
  });

  it("waits behind a run that is moving rather than racing it", async () => {
    state.row = { menuId: "menu-1", collections: {} };
    state.claimed = false;

    await handleTypeMenuSync({
      data: { shopDomain: "shop.myshopify.com", automatic: true },
    } as Job<unknown>);

    expect(state.requeued).toBe(1);
    expect(state.menus).toEqual([]);
  });

  it("updates the menu automatically once it exists", async () => {
    state.row = { menuId: "menu-1", collections: {} };

    await handleTypeMenuSync({
      data: { shopDomain: "shop.myshopify.com", automatic: true },
    } as Job<unknown>);

    expect(state.menus[0]?.menuId).toBe("menu-1");
    expect(state.patches.at(-1)).toMatchObject({ status: "done" });
  });

  it("skips products Shopify has deleted and says so", async () => {
    state.extraProducts = ["gone-1", "p2"];

    await handleTypeMenuSync(job);

    expect(
      state.writes.map((w) => (w as { ownerId: string }).ownerId).sort(),
    ).toEqual(["p1", "p2"]);
    expect(state.patches.at(-1)).toMatchObject({
      status: "done",
      lastError: expect.stringMatching(/1 product .* no longer exists/),
    });
  });

  it("finishes when the old single-value field cannot be removed", async () => {
    state.legacyFails = true;

    await handleTypeMenuSync(job);

    expect(state.patches.at(-1)).toMatchObject({ status: "done" });
  });

  it("records a refusal Shopify explains and does not retry it", async () => {
    const { TypeMenuError } = await import("~/adapters/shopify/type-menu");
    state.fail = new TypeMenuError("Approve the new permissions.");

    await expect(handleTypeMenuSync(job)).resolves.toBeUndefined();
    expect(state.patches.at(-1)).toMatchObject({
      status: "failed",
      lastError: "Approve the new permissions.",
    });
  });

  it("records an unexpected failure and lets the queue retry it", async () => {
    state.fail = new Error("socket hang up");

    await expect(handleTypeMenuSync(job)).rejects.toThrow("socket hang up");
    expect(state.patches.at(-1)).toMatchObject({ status: "failed" });
  });
});
