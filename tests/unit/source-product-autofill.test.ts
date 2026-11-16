import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/sources.md § AI categorization per source: a product the export
 * portal created is put to autofill when its source is switched on, with
 * that source's choice of what to fill; anything else is left alone.
 */

const state = vi.hoisted(() => ({
  settings: new Map<
    string,
    { enabled: boolean; fillAttributes: boolean; autoApply: boolean }
  >(),
  available: true,
  requests: [] as Array<{
    ids: string[];
    by: string | null;
    fill: boolean;
    autoApply: boolean;
  }>,
}));

vi.mock("~/adapters/db/repositories/source-autofill.server", () => ({
  getSourceAutofill: async (_p: unknown, sourceId: string) =>
    state.settings.get(sourceId) ?? {
      enabled: false,
      fillAttributes: true,
      autoApply: false,
    },
}));
vi.mock("~/adapters/products/autofill.server", () => ({
  autofillAvailability: async () =>
    state.available
      ? { ok: true }
      : { ok: false, message: "Connect the export portal first." },
  requestAutofill: async (
    _p: unknown,
    ids: string[],
    by: string | null,
    options: { fillAttributes: boolean; autoApply?: boolean },
  ) => {
    state.requests.push({
      ids,
      by,
      fill: options.fillAttributes,
      autoApply: options.autoApply ?? false,
    });
    return ids.length;
  },
}));

const { handleSourceProductAutofill } =
  await import("~/jobs/handlers/source-product-autofill");

function created(tags: string) {
  return {
    data: {
      shopDomain: "shop.myshopify.com",
      webhookId: "w1",
      topic: "products/create",
      payload: {
        id: 42,
        admin_graphql_api_id: "gid://shopify/Product/42",
        title: "AC-X 5.3",
        tags,
        variants: [],
      },
    },
  } as unknown as Job<unknown>;
}

beforeEach(() => {
  state.settings.clear();
  state.available = true;
  state.requests = [];
});

describe("a source's new product", () => {
  it("is autofilled when its source is on, as the source says", async () => {
    state.settings.set("sc_1", {
      enabled: true,
      fillAttributes: false,
      autoApply: false,
    });
    await handleSourceProductAutofill(
      created("awaiting-review, portal-source:sc_1"),
    );
    expect(state.requests).toEqual([
      {
        ids: ["gid://shopify/Product/42"],
        by: "source:sc_1",
        fill: false,
        autoApply: false,
      },
    ]);
  });

  it("is recognised without the review tag, and applied if the source says", async () => {
    state.settings.set("sc_2", {
      enabled: true,
      fillAttributes: true,
      autoApply: true,
    });
    await handleSourceProductAutofill(created("Foils, portal-source:sc_2"));
    expect(state.requests).toEqual([
      {
        ids: ["gid://shopify/Product/42"],
        by: "source:sc_2",
        fill: true,
        autoApply: true,
      },
    ]);
  });

  it("is left alone when its source is off or it has no source", async () => {
    state.settings.set("sc_1", {
      enabled: false,
      fillAttributes: true,
      autoApply: false,
    });
    await handleSourceProductAutofill(created("portal-source:sc_1"));
    await handleSourceProductAutofill(created("sale"));
    expect(state.requests).toEqual([]);
  });

  it("is left alone when the portal cannot be asked", async () => {
    state.settings.set("sc_1", {
      enabled: true,
      fillAttributes: true,
      autoApply: false,
    });
    state.available = false;
    await handleSourceProductAutofill(created("portal-source:sc_1"));
    expect(state.requests).toEqual([]);
  });
});
