import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { rigPack } from "~/domain/attributes/rig-pack";
import type { AutofillValue } from "~/domain/products/autofill";
import type { Principal } from "~/domain/types";
import {
  envelope,
  installFakeClaude,
  scripted,
} from "../support/fake-claude-pool";

/**
 * docs/attributes.md § Bulk filling with claude-pool: the runner against a
 * fake claude-pool executable and an in-memory stand-in for the repositories.
 * Exit 75 pauses and resumes, three bad replies fail one product and not the
 * run, and a second run asks only the products without a row or with a
 * failed one.
 */

interface Row {
  status: "ready" | "discarded" | "failed";
  source: string | null;
  model: string | null;
  values: AutofillValue[];
  typeId: string | null;
  error?: string;
}

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  seen: [] as string[],
  products: [] as Array<{ id: string; productType: string | null }>,
  usage: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
}));

const note = (principal: Principal) => {
  state.seen.push(principal.shopDomain);
};

vi.mock("~/adapters/db/repositories/attribute-schema.server", async () => {
  const { rigPack: pack } = await import("~/domain/attributes/rig-pack");
  return {
    getAttributeSchema: async (principal: Principal) => {
      note(principal);
      return { schema: pack(), revision: 1 };
    },
  };
});
vi.mock("~/adapters/db/repositories/event-log.server", () => ({
  appendEvent: async (principal: Principal, entry: Record<string, unknown>) => {
    note(principal);
    state.events.push(entry);
  },
}));
vi.mock("~/adapters/db/repositories/translations.server", () => ({
  recordUsage: async (principal: Principal, write: Record<string, unknown>) => {
    note(principal);
    state.usage.push(write);
  },
}));
vi.mock("~/adapters/db/repositories/product-type-assignment.server", () => ({
  assignmentsFor: async (principal: Principal) => {
    note(principal);
    return new Map();
  },
}));
vi.mock("~/adapters/db/repositories/product-autofill.server", () => ({
  nextUnaskedProducts: async (
    principal: Principal,
    after: string | null,
    limit: number,
  ) => {
    note(principal);
    const ids = state.products
      .map((p) => p.id)
      .filter((id) => (after === null || id > after) && !isAsked(id))
      .slice(0, limit);
    const last = ids.at(-1) ?? null;
    return { ids, next: ids.length === limit ? last : null };
  },
  saveAutofillSuggestion: async (
    principal: Principal,
    id: string,
    s: {
      typeId: string | null;
      values: AutofillValue[];
      source?: string;
      model?: string | null;
      engine: string;
    },
  ) => {
    note(principal);
    state.rows.set(id, {
      status: "ready",
      source: s.source ?? s.engine,
      model: s.model ?? null,
      values: s.values,
      typeId: s.typeId,
    });
  },
  recordNothingSuggested: async (
    principal: Principal,
    id: string,
    p: { source: string; model: string | null },
    typeId: string | null,
  ) => {
    note(principal);
    state.rows.set(id, {
      status: "discarded",
      source: p.source,
      model: p.model,
      values: [],
      typeId,
    });
  },
  failAutofill: async (
    principal: Principal,
    id: string,
    error: string,
    source: string | null,
  ) => {
    note(principal);
    state.rows.set(id, {
      status: "failed",
      source,
      model: null,
      values: [],
      typeId: null,
      error,
    });
  },
}));
vi.mock("~/adapters/db/repositories/rig-catalogue.server", () => ({
  catalogueForFill: async (principal: Principal, ids: string[]) => {
    note(principal);
    return state.products
      .filter((p) => ids.includes(p.id))
      .map((p) => ({
        productId: p.id,
        categoryName: null,
        productType: p.productType,
        metafields: {},
        variants: [
          { variantId: `${p.id}-v1`, metafields: {} },
          { variantId: `${p.id}-v2`, metafields: {} },
        ],
        product: {
          title: `Sail ${p.id}`,
          vendor: "Point-7",
          productType: p.productType ?? "",
          category: null,
          tags: [],
          description: "",
          variants: [
            { variantId: `${p.id}-v1`, title: "5.3", options: [] },
            { variantId: `${p.id}-v2`, title: "5.8", options: [] },
          ],
        },
      }));
  },
}));

function isAsked(id: string): boolean {
  const row = state.rows.get(id);
  return row !== undefined && row.status !== "failed";
}

const { runFill, MAX_ATTEMPTS } =
  await import("~/adapters/products/fill-runner.server");

const fake = installFakeClaude();
const work = mkdtempSync(join(tmpdir(), "fill-runner-test-"));

function script(...lines: string[]) {
  const file = join(work, `script-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, lines.join("\n") + "\n");
  fake.set("script", file);
}

const reply = (...items: unknown[]) =>
  scripted(0, envelope(JSON.stringify({ values: items }), "claude-fake-1"));

const category = { attributeId: "rig_sail_category", value: "freeride" };
const area = (variantId: string, value: string) => ({
  attributeId: "rig_sail_area_m2",
  variantId,
  value,
});

beforeAll(() => {
  vi.stubEnv("PATH", fake.pathWith());
});
beforeEach(() => {
  state.rows.clear();
  state.seen.length = 0;
  state.usage.length = 0;
  state.events.length = 0;
  state.products = [
    { id: "p1", productType: "Sails" },
    { id: "p2", productType: "Sails" },
    { id: "p3", productType: "Sails" },
    { id: "p4", productType: null },
    { id: "p5", productType: "Mystery gear" },
  ];
});
afterEach(() => {
  fake.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("PATH", fake.pathWith());
});

const base = {
  shopDomain: "shop-a.myshopify.com",
  types: null,
  limit: null,
  concurrency: 1,
  timeoutMs: 20_000,
  log: () => undefined,
  waitMs: async () => 30,
};

describe("runFill", () => {
  it("fills, pauses on exit 75, fails one product after three bad replies, and resumes", async () => {
    script(
      reply(category, area("p1-v1", "5,3 m²"), area("p1-v2", "5.8")),
      scripted(75),
      reply(category),
      scripted(1),
      scripted(1),
      scripted(1),
    );
    const first = await runFill(base);
    expect(first).toMatchObject({
      asked: 3,
      suggested: 2,
      failed: 1,
      noType: 2,
      pauses: 1,
    });
    expect(state.rows.get("p1")).toMatchObject({
      status: "ready",
      source: "claude-pool",
      model: "claude-fake-1",
      typeId: "rig_sails",
    });
    expect(state.rows.get("p1")?.values.map((v) => [v.key, v.input])).toEqual([
      ["rig_sail_category", "freeride"],
      ["rig_sail_area_m2@p1-v1", "5.3"],
      ["rig_sail_area_m2@p1-v2", "5.8"],
    ]);
    expect(state.rows.get("p2")).toMatchObject({ status: "ready" });
    expect(state.rows.get("p3")).toMatchObject({
      status: "failed",
      source: "claude-pool",
    });
    // Exhaustion never failed a product; the usage ledger counts answered requests, unpriced.
    expect(state.usage.length).toBeGreaterThanOrEqual(2);
    expect(state.usage[0]).toMatchObject({
      purpose: "autofill",
      estimatedCostMicros: null,
      model: "claude-fake-1",
    });
    expect(MAX_ATTEMPTS).toBe(3);

    // A second run asks only the failed one: p1 and p2 keep their rows.
    script(reply(category));
    const second = await runFill(base);
    expect(second.asked).toBe(1);
    expect(state.rows.get("p3")).toMatchObject({ status: "ready" });
    expect(state.rows.get("p1")?.values).toHaveLength(3);
  });

  it("records an answer with nothing usable as decided, so it is not asked again", async () => {
    script(reply({ attributeId: "rig_sail_category", value: "surf" }));
    state.products = [{ id: "p1", productType: "Sails" }];
    const summary = await runFill(base);
    expect(summary).toMatchObject({ asked: 1, nothing: 1, suggested: 0 });
    expect(state.rows.get("p1")?.status).toBe("discarded");
    expect((await runFill(base)).asked).toBe(0);
  });

  it("limits to the rig types asked for", async () => {
    script(reply(category));
    const summary = await runFill({ ...base, types: ["masts"] });
    expect(summary.asked).toBe(0);
    expect(state.rows.size).toBe(0);
  });

  it("stops at --limit", async () => {
    script(reply(category));
    const summary = await runFill({ ...base, limit: 1 });
    expect(summary.asked).toBe(1);
    expect(state.rows.size).toBe(1);
  });

  it("stays inside the shop it was given", async () => {
    script(reply(category));
    state.products = [{ id: "p1", productType: "Sails" }];
    await runFill(base);
    expect(new Set(state.seen)).toEqual(new Set(["shop-a.myshopify.com"]));
    await runFill({ ...base, shopDomain: "shop-b.myshopify.com" });
    expect(new Set(state.seen)).toEqual(
      new Set(["shop-a.myshopify.com", "shop-b.myshopify.com"]),
    );
    expect(rigPack().types.length).toBeGreaterThan(0);
  });

  it("does not hand the model anything but product data", async () => {
    const args = join(work, "prompt-args");
    fake.set("args", args);
    script(reply(category));
    state.products = [{ id: "p1", productType: "Sails" }];
    vi.stubEnv("DATABASE_URL", "postgres://secret@db/x");
    await runFill(base);
    const { readFileSync } = await import("node:fs");
    const seen = readFileSync(args, "utf8");
    expect(seen).toContain("Sail p1");
    expect(seen).not.toContain("postgres://");
    expect(seen).toContain("--tools");
  });
});
