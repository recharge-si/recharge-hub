import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannedChange } from "~/domain/values/import";

/**
 * docs/attributes.md § Bulk values › Applying: twenty-five values a call,
 * Shopify re-read first, a value someone changed since left alone, a run
 * that stops visited again without writing twice, and an audit event with
 * counts only. Shopify is a fake that keeps metafields in a map.
 */

const state = vi.hoisted(() => ({
  changes: [] as unknown[],
  outcomes: [] as Array<string | null>,
  status: "queued",
  finished: null as null | { status: string; lastError?: string | null },
  mirrored: [] as unknown[],
  events: [] as unknown[],
}));

vi.mock("~/adapters/db/repositories/bulk-values.server", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    startRun: async () => {
      if (state.status === "done") return null;
      return {
        id: "imp1",
        changes: state.changes as PlannedChange[],
        outcomes: [...state.outcomes],
      };
    },
    saveProgress: async (_: string, __: string, outcomes: Array<string | null>) => {
      state.outcomes = [...outcomes];
    },
    finishRun: async (
      _: string,
      __: string,
      result: { status: string; lastError?: string | null },
    ) => {
      state.finished = result;
      state.status = result.status;
    },
    mirrorMetafields: async (_: string, writes: unknown[]) => {
      state.mirrored.push(...writes);
    },
  };
});

vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: async (_: unknown, entry: unknown) => {
    state.events.push(entry);
  },
}));

import { applyBatch, decide, runBulkApply } from "~/adapters/products/bulk-values.server";

type Stored = { type: string; value: string };

/** A Shopify that holds metafields by owner and answers the three calls bulk values makes. */
function fakeShopify(initial: Record<string, Record<string, Stored>> = {}) {
  const store = new Map(
    Object.entries(initial).map(([owner, map]) => [owner, { ...map }]),
  );
  const calls = { reads: 0, sets: [] as number[], deletes: [] as number[], singles: 0 };
  const refuse = new Set<string>();
  const graphql = async (query: string, options?: { variables?: Record<string, unknown> }) => {
    const v = options?.variables ?? {};
    let data: unknown;
    if (query.includes("OrchestratorOwnerMetafields")) {
      calls.reads += 1;
      const ids = v.ids as string[];
      data = {
        nodes: ids.map((id) => {
          const owned = store.get(id);
          if (!owned) return null;
          const wanted = new Set(v.keys as string[]);
          return {
            id,
            metafields: {
              nodes: Object.entries(owned)
                .filter(([name]) => wanted.has(name))
                .map(([name, m]) => ({
                  namespace: name.split(".")[0],
                  key: name.split(".")[1],
                  type: m.type,
                  value: m.value,
                })),
            },
          };
        }),
      };
    } else if (query.includes("MetafieldsSet")) {
      const list = v.metafields as Array<{
        ownerId: string;
        namespace: string;
        key: string;
        type: string;
        value: string;
      }>;
      calls.sets.push(list.length);
      if (list.length === 1) calls.singles += 1;
      const bad = list.findIndex((m) => refuse.has(`${m.ownerId}|${m.key}`));
      if (bad >= 0) {
        data = {
          metafieldsSet: {
            userErrors: [
              { field: ["metafields", String(bad), "value"], message: "Value must be a decimal." },
            ],
          },
        };
      } else {
        for (const m of list) {
          const owned = store.get(m.ownerId) ?? {};
          owned[`${m.namespace}.${m.key}`] = { type: m.type, value: m.value };
          store.set(m.ownerId, owned);
        }
        data = { metafieldsSet: { userErrors: [] } };
      }
    } else if (query.includes("MetafieldsDelete")) {
      const list = v.metafields as Array<{ ownerId: string; namespace: string; key: string }>;
      calls.deletes.push(list.length);
      for (const m of list) delete store.get(m.ownerId)?.[`${m.namespace}.${m.key}`];
      data = { metafieldsDelete: { userErrors: [] } };
    } else throw new Error(`unexpected query ${query.slice(0, 60)}`);
    return { json: async () => ({ data }) };
  };
  return {
    admin: { graphql } as unknown as AdminApiContext,
    store,
    calls,
    refuse,
    valueOf: (owner: string, name: string) => store.get(owner)?.[name]?.value,
  };
}

const dim = (value: number) => ({
  type: "dimension",
  value: JSON.stringify({ value, unit: "CENTIMETERS" }),
});
const wire = (value: number) => JSON.stringify({ value, unit: "CENTIMETERS" });

function change(i: number, overrides: Partial<PlannedChange> = {}): PlannedChange {
  const owner = `gid://shopify/ProductVariant/${i}`;
  return {
    row: i + 1,
    ownerId: owner,
    productId: "gid://shopify/Product/1",
    scope: "variant",
    attributeId: "a1",
    name: "Luff",
    namespace: "recharge",
    key: "luff_cm",
    kind: "measurement",
    shopifyType: "dimension",
    op: "set",
    value: wire(400),
    before: null,
    beforeCanon: "",
    afterCanon: "400",
    beforeText: "",
    afterText: "400 cm",
    defined: true,
    ...overrides,
  };
}

function load(changes: PlannedChange[], outcomes?: Array<string | null>) {
  state.changes = changes;
  state.outcomes = outcomes ?? changes.map(() => null);
  state.status = "queued";
  state.finished = null;
  state.mirrored = [];
  state.events = [];
}

const owners = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`gid://shopify/ProductVariant/${i}`, {}]),
  );

beforeEach(() => load([]));

describe("deciding one change", () => {
  const c = change(1);
  it("writes when Shopify still holds what the preview saw", () => {
    expect(decide(c, undefined, true)).toBe("write");
  });
  it("leaves a value someone changed since", () => {
    expect(decide(c, dim(380), true)).toBe("changed_meanwhile");
  });
  it("sees a value already as wanted", () => {
    expect(decide(c, dim(400), true)).toBe("unchanged");
  });
  it("sees an owner Shopify no longer has", () => {
    expect(decide(c, undefined, false)).toBe("gone");
  });
});

describe("applying a stored preview", () => {
  it("writes in batches of 25, reading Shopify before each batch", async () => {
    const fake = fakeShopify(owners(60));
    load(Array.from({ length: 60 }, (_, i) => change(i)));
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(fake.calls.sets).toEqual([25, 25, 10]);
    expect(fake.calls.reads).toBe(3);
    expect(state.outcomes.every((o) => o === "written")).toBe(true);
    expect(fake.valueOf("gid://shopify/ProductVariant/59", "recharge.luff_cm")).toBe(wire(400));
    expect(state.finished).toEqual({ status: "done" });
  });

  it("skips a value changed since the preview and says so, writing the rest", async () => {
    const fake = fakeShopify({
      ...owners(3),
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(380) },
    });
    load([change(0), change(1), change(2)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual(["written", "changed_meanwhile", "written"]);
    expect(fake.valueOf("gid://shopify/ProductVariant/1", "recharge.luff_cm")).toBe(wire(380));
  });

  it("changes an existing value only while it is still the one the preview saw", async () => {
    const fake = fakeShopify({
      "gid://shopify/ProductVariant/0": { "recharge.luff_cm": dim(390) },
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(391) },
    });
    const seen = (value: number) => ({
      before: dim(value),
      beforeCanon: String(value),
    });
    load([change(0, seen(390)), change(1, seen(390))]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual(["written", "changed_meanwhile"]);
  });

  it("clears with metafieldsDelete, and leaves a clear whose value changed", async () => {
    const fake = fakeShopify({
      "gid://shopify/ProductVariant/0": { "recharge.luff_cm": dim(390) },
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(111) },
    });
    const clear = (i: number) =>
      change(i, {
        op: "clear",
        value: null,
        before: dim(390),
        beforeCanon: "390",
        afterCanon: "",
      });
    load([clear(0), clear(1)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual(["cleared", "changed_meanwhile"]);
    expect(fake.calls.deletes).toEqual([1]);
    expect(fake.valueOf("gid://shopify/ProductVariant/0", "recharge.luff_cm")).toBeUndefined();
    expect(state.mirrored).toContainEqual(
      expect.objectContaining({ ownerId: "gid://shopify/ProductVariant/0", stored: null }),
    );
  });

  it("is idempotent: a second run writes nothing", async () => {
    const fake = fakeShopify(owners(30));
    load(Array.from({ length: 30 }, (_, i) => change(i)));
    await runBulkApply(fake.admin, "shop.test", "imp1");
    const first = { ...fake.calls, sets: [...fake.calls.sets] };
    state.status = "queued";
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(fake.calls.sets).toEqual(first.sets);
    expect(fake.calls.reads).toBe(first.reads);
  });

  it("resumes: a change with an outcome is not visited, one without is judged afresh", async () => {
    // Variant 0 was written and recorded; variant 1 was written but the run
    // stopped before recording it; variant 2 was never reached.
    const fake = fakeShopify({
      ...owners(3),
      "gid://shopify/ProductVariant/0": { "recharge.luff_cm": dim(400) },
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(400) },
    });
    load([change(0), change(1), change(2)], ["written", null, null]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual(["written", "unchanged", "written"]);
    expect(fake.calls.sets).toEqual([1]);
  });

  it("writes a refused batch one value at a time and names the refused one", async () => {
    const fake = fakeShopify(owners(4));
    fake.refuse.add("gid://shopify/ProductVariant/2|luff_cm");
    load([change(0), change(1), change(2), change(3)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual([
      "written",
      "written",
      "failed:Value must be a decimal.",
      "written",
    ]);
    expect(fake.calls.singles).toBe(4);
  });

  it("reports an owner Shopify no longer has", async () => {
    const fake = fakeShopify(owners(1));
    load([change(0), change(7)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.outcomes).toEqual(["written", "gone"]);
  });

  it("mirrors what it wrote into the snapshot, and only that", async () => {
    const fake = fakeShopify({
      ...owners(2),
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(380) },
    });
    load([change(0), change(1)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.mirrored).toEqual([
      {
        ownerId: "gid://shopify/ProductVariant/0",
        scope: "variant",
        name: "recharge.luff_cm",
        stored: { type: "dimension", value: wire(400) },
      },
    ]);
  });

  it("logs product.values_imported with counts only, never a value", async () => {
    const fake = fakeShopify({
      ...owners(3),
      "gid://shopify/ProductVariant/1": { "recharge.luff_cm": dim(380) },
    });
    load([change(0), change(1), change(2)]);
    await runBulkApply(fake.admin, "shop.test", "imp1");
    expect(state.events).toHaveLength(1);
    const event = state.events[0] as { event: string; detail: Record<string, unknown> };
    expect(event.event).toBe("product.values_imported");
    expect(event.detail).toMatchObject({ written: 2, changedMeanwhile: 1, total: 3 });
    expect(JSON.stringify(event)).not.toContain("400");
    expect(Object.values(event.detail).every((v) => typeof v === "number")).toBe(true);
  });

  it("marks the import failed, keeping progress, when Shopify cannot be reached", async () => {
    const fake = fakeShopify(owners(30));
    let reads = 0;
    const inner = fake.admin.graphql;
    (fake.admin as unknown as { graphql: unknown }).graphql = async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      if (query.includes("OwnerMetafields") && (reads += 1) === 2)
        throw new Error("socket hang up");
      return inner(query, options);
    };
    load(Array.from({ length: 30 }, (_, i) => change(i)));
    await expect(runBulkApply(fake.admin, "shop.test", "imp1")).rejects.toThrow("socket");
    expect(state.finished?.status).toBe("failed");
    expect(state.outcomes.filter((o) => o === "written")).toHaveLength(25);
    expect(state.outcomes.slice(25).every((o) => o === null)).toBe(true);
  });
});

describe("a batch", () => {
  it("returns an outcome per index", async () => {
    const fake = fakeShopify(owners(2));
    const changes = [change(0), change(1)];
    const result = await applyBatch(fake.admin, changes, [1]);
    expect([...result]).toEqual([[1, "written"]]);
  });
});
