import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LIMITS } from "~/domain/values/types";

import {
  SHOP,
  valuesCatalogue,
  valuesPlan,
} from "../support/values-fixtures";

/**
 * docs/attributes.md § Bulk values, at the route: what a request does and
 * refuses. The database, the queue and Shopify are stand-ins; what is held
 * to account is the order of things (nothing written on preview, the shop on
 * every call) and the sentences a person reads.
 */

const spy = vi.hoisted(() => ({
  created: [] as unknown[],
  claimed: [] as unknown[],
  enqueued: [] as unknown[],
  finished: [] as unknown[],
  claim: { ok: true } as { ok: boolean; reason?: string },
  lightExtra: 0,
}));

vi.mock("~/adapters/db/repositories/attribute-schema.server", async () => {
  const { valuesPlan: plan } = await import("../support/values-fixtures");
  return { getAttributeSchema: async () => ({ schema: plan(), revision: 1 }) };
});

vi.mock("~/adapters/db/repositories/bulk-values.server", async () => {
  const { valuesCatalogue: catalogue } = await import("../support/values-fixtures");
  return {
    listLightProducts: async () =>
      catalogue().map((p, i) => ({
        productId: p.productId,
        productType: p.productType,
        categoryName: p.categoryName,
        chosenTypeId: p.chosenTypeId,
        variantCount: p.variants.length + (i === 0 ? spy.lightExtra : 0),
      })),
    loadValuesProducts: async (
      _principal: unknown,
      ids: { productIds?: string[]; variantIds?: string[] },
    ) =>
      catalogue().filter(
        (p) =>
          ids.productIds?.includes(p.productId) ||
          p.variants.some((v) => ids.variantIds?.includes(v.variantId)),
      ),
    createImport: async (principal: unknown, input: unknown) => {
      spy.created.push({ principal, input });
      return "imp-new";
    },
    claimApply: async (principal: unknown, id: string, by: string | null) => {
      spy.claimed.push({ principal, id, by });
      return spy.claim;
    },
    finishRun: async (...args: unknown[]) => {
      spy.finished.push(args);
    },
    discardImport: async () => true,
    getImport: async () => null,
  };
});

vi.mock("~/adapters/queue/boss.server", () => ({
  enqueue: async (...args: unknown[]) => {
    spy.enqueued.push(args);
    return "job";
  },
}));

const graphqlCalls: string[] = [];
vi.mock("~/adapters/shopify/products", () => ({
  listMetafieldDefinitions: async () => {
    graphqlCalls.push("definitions");
    return [
      { namespace: "recharge", key: "length_cm", name: "Length", ownerType: "PRODUCTVARIANT", type: "dimension" },
    ];
  },
}));

import {
  applyValues,
  exportValues,
  previewValues,
  refuseFile,
  typeChoices,
} from "~/web/lib/bulk-values.server";

const admin = {} as AdminApiContext;
const principal = {
  kind: "shop" as const,
  shopDomain: SHOP,
  isShopOwner: true,
};

beforeEach(() => {
  spy.created = [];
  spy.claimed = [];
  spy.enqueued = [];
  spy.finished = [];
  spy.claim = { ok: true };
  spy.lightExtra = 0;
  graphqlCalls.length = 0;
});

describe("the export route", () => {
  it("refuses a request that names no type", async () => {
    const out = await exportValues(admin, principal, { typeIds: [], preset: "rig" });
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it("ignores a type id that is not a type of this shop's plan", async () => {
    const out = await exportValues(admin, principal, {
      typeIds: ["not-a-type"],
      preset: "rig",
    });
    expect(out.ok).toBe(false);
  });

  it("returns a CSV with a byte order mark for the chosen types", async () => {
    const out = await exportValues(admin, principal, {
      typeIds: ["masts"],
      preset: "rig",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.startsWith("\uFEFF")).toBe(true);
    expect(out.rows).toBe(3);
    expect(out.fileName).toMatch(/^attribute-values-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(out.body).toContain("Length [recharge.length_cm] (cm)");
  });

  it("refuses more than the row cap with a sentence", async () => {
    spy.lightExtra = LIMITS.exportRows;
    const out = await exportValues(admin, principal, {
      typeIds: ["masts"],
      preset: "rig",
    });
    expect(out).toMatchObject({ ok: false, status: 413 });
    if (!out.ok) expect(out.message).toContain("at most 10,000");
  });
});

describe("the type choices", () => {
  it("counts products and variants per type, only for types in use", async () => {
    const { choices, catalogueRead } = await typeChoices(principal);
    expect(catalogueRead).toBe(true);
    expect(choices.find((c) => c.typeId === "masts")).toMatchObject({
      products: 1,
      variants: 3,
    });
    expect(choices.find((c) => c.typeId === "wave-sails")).toBeUndefined();
  });
});

describe("the preview", () => {
  const header =
    "product_id,variant_id,Length [recharge.length_cm] (cm)\n";
  const row = `gid://shopify/Product/100,gid://shopify/ProductVariant/1001,370\n`;

  it("stores a preview and writes nothing to Shopify", async () => {
    const mutations: string[] = [];
    const watching = {
      graphql: async (query: string) => {
        mutations.push(query);
        return { json: async () => ({}) };
      },
    } as unknown as AdminApiContext;
    const out = await previewValues(watching, principal, {
      name: "masts.csv",
      text: header + row,
      actor: "staff:1",
    });
    expect(out).toEqual({ ok: true, importId: "imp-new" });
    expect(mutations).toEqual([]);
    expect(graphqlCalls).toEqual(["definitions"]);
    const stored = spy.created[0] as {
      principal: { shopDomain: string };
      input: { plan: { counts: { set: number }; changes: Array<{ defined: boolean }> } };
    };
    expect(stored.principal.shopDomain).toBe(SHOP);
    expect(stored.input.plan.counts.set).toBe(1);
    expect(stored.input.plan.changes[0]?.defined).toBe(true);
  });

  it("reads a file with a byte order mark and semicolons", async () => {
    const out = await previewValues(admin, principal, {
      name: "x.csv",
      text:
        "\uFEFFproduct_id;variant_id;Length [recharge.length_cm] (cm)\n" +
        "gid://shopify/Product/100;gid://shopify/ProductVariant/1001;370,5\n",
      actor: null,
    });
    expect(out.ok).toBe(true);
    const stored = spy.created[0] as { input: { plan: { counts: { set: number } } } };
    expect(stored.input.plan.counts.set).toBe(1);
  });

  it("refuses a file larger than the cap with a sentence", async () => {
    const out = await previewValues(admin, principal, {
      name: "big.csv",
      text: header + "x".repeat(LIMITS.fileBytes),
      actor: null,
    });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.message).toContain("larger than 2 MB");
    expect(spy.created).toEqual([]);
  });

  it("refuses what is not a CSV", async () => {
    for (const [name, text] of [
      ["values.xlsx", "PK\u0003\u0004binary"],
      ["values.csv", '{"a":1}'],
      ["values.csv", "<html></html>"],
      ["values.csv", "a,b\u0000c"],
      ["values.csv", "caf�"],
      ["values.csv", ""],
    ] as const) {
      const out = await previewValues(admin, principal, { name, text, actor: null });
      expect(out.ok, `${name} ${text.slice(0, 8)}`).toBe(false);
    }
    expect(spy.created).toEqual([]);
    expect(refuseFile("a.csv", "product_id,variant_id\n1,2\n")).toBeNull();
  });

  it("stores a file that cannot be read as a preview that says why", async () => {
    const out = await previewValues(admin, principal, {
      name: "wrong.csv",
      text: "colour,size\nred,big\n",
      actor: null,
    });
    expect(out.ok).toBe(true);
    const stored = spy.created[0] as {
      input: { plan: { fileErrors: string[]; safeToApply: boolean } };
    };
    expect(stored.input.plan.fileErrors[0]).toContain("product_id or variant_id");
    expect(stored.input.plan.safeToApply).toBe(false);
  });
});

describe("applying", () => {
  it("claims for this shop and queues one job for the preview", async () => {
    const out = await applyValues(principal, "imp1", "staff:1");
    expect(out).toEqual({ ok: true });
    expect(spy.claimed).toEqual([{ principal, id: "imp1", by: "staff:1" }]);
    expect(spy.enqueued).toHaveLength(1);
    const [queue, payload, options] = spy.enqueued[0] as [
      string,
      { shopDomain: string; importId: string },
      { singletonKey: string },
    ];
    expect(queue).toBe("bulk-values-apply");
    expect(payload).toEqual({ shopDomain: SHOP, importId: "imp1" });
    expect(options.singletonKey).toBe("bulk-values:imp1");
  });

  it("queues nothing when the preview is not this shop's, expired or busy", async () => {
    for (const reason of ["unknown", "expired", "busy", "already", "nothing"]) {
      spy.claim = { ok: false, reason };
      const out = await applyValues(principal, "imp1", null);
      expect(out.ok, reason).toBe(false);
    }
    expect(spy.enqueued).toEqual([]);
  });
});

describe("the CSV route", () => {
  it("answers 400 as plain text, and the file as an attachment", async () => {
    vi.doMock("~/adapters/shopify/shopify.server", () => ({
      authenticate: {
        admin: async () => ({
          admin,
          session: { shop: SHOP, onlineAccessInfo: undefined },
        }),
      },
    }));
    const { loader } = await import("~/web/routes/app.product-setup.values[.csv]");
    const bad = (await loader({
      request: new Request("https://app.test/app/product-setup/values.csv"),
      params: {},
      context: {},
    } as never)) as Response;
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Content-Type")).toContain("text/plain");

    const good = (await loader({
      request: new Request(
        "https://app.test/app/product-setup/values.csv?types=masts,booms&attributes=rig",
      ),
      params: {},
      context: {},
    } as never)) as Response;
    expect(good.status).toBe(200);
    expect(good.headers.get("Content-Type")).toContain("text/csv");
    expect(good.headers.get("Content-Disposition")).toContain("attribute-values-");
    expect(good.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await good.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("the fixtures", () => {
  it("are what the other tests read", () => {
    expect(valuesPlan().attributes.length).toBeGreaterThan(10);
    expect(valuesCatalogue()).toHaveLength(4);
  });
});
