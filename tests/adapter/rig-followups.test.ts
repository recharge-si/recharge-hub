import { describe, expect, it } from "vitest";

import type { RigCall } from "~/adapters/rig/api.server";

import { type Json, post, read, setup } from "../support/rig-api-harness";
import { REFERENCE } from "../support/rig-fixtures";

/**
 * The follow-up contract: `excludeVariantIds` on build, explain and verify,
 * the display fields on items and alternatives, and one breadcrumb per call.
 */

async function built(extra: Record<string, unknown> = {}) {
  const ctx = setup();
  const body = await read(
    await ctx.api.build(post({ answers: REFERENCE, ...extra })),
  );
  return { ...ctx, body };
}

describe("excludeVariantIds", () => {
  it("build: the rig and its alternatives leave the variant out", async () => {
    const { body } = await built();
    const sail = body.rigs[0].items.find((i: Json) => i.role === "sail");
    const swap = body.rigs[0].alternatives.find((a: Json) => a.role === "board");
    const again = await built({ excludeVariantIds: [sail.variantId, swap.variantId] });
    const ids = [
      ...again.body.rigs[0].items,
      ...again.body.rigs[0].alternatives,
    ].map((p: Json) => p.variantId);
    expect(ids).not.toContain(sail.variantId);
    expect(ids).not.toContain(swap.variantId);
    expect(again.body.rigs[0].items.length).toBe(body.rigs[0].items.length);
  });

  it("explain: the same exclusion applies", async () => {
    const { body } = await built();
    const sail = body.rigs[0].items.find((i: Json) => i.role === "sail");
    const ctx = setup();
    const explained = await read(
      await ctx.api.explain(
        post({ answers: REFERENCE, excludeVariantIds: [sail.variantId] }),
      ),
    );
    expect(explained.variantIds.length).toBeGreaterThan(0);
    expect(explained.variantIds).not.toContain(sail.variantId);
  });

  it("verify: an excluded variant fails with excluded-variant-<id>", async () => {
    const { body, api } = await built();
    const ids: number[] = body.rigs[0].items.map((i: Json) => i.variantId);
    const target = ids[0] as number;
    const verdict = await read(
      await api.verify(
        post({ variantIds: ids, answers: REFERENCE, excludeVariantIds: [target] }),
      ),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.checks).toContainEqual({
      id: `excluded-variant-${target}`,
      ok: false,
    });
    expect(
      verdict.items.find((i: Json) => i.variantId === target).available,
    ).toBe(false);
    // Without the exclusion the same rig passes.
    const clean = await read(
      await api.verify(post({ variantIds: ids, answers: REFERENCE })),
    );
    expect(clean.ok).toBe(true);
  });

  it("is checked: at most 50 positive integers", async () => {
    const { api } = setup();
    const many = await api.build(
      post({ answers: REFERENCE, excludeVariantIds: Array.from({ length: 51 }, (_, i) => i + 1) }),
    );
    expect(many.status).toBe(400);
    const bad = await api.verify(
      post({ variantIds: [1], excludeVariantIds: [-3] }),
    );
    expect(bad.status).toBe(400);
    const text = await api.build(
      post({ answers: REFERENCE, excludeVariantIds: ["7"] }),
    );
    expect(text.status).toBe(400);
  });
});

describe("display fields", () => {
  it("every item carries image, product link, vendor, specs, facts and derived", async () => {
    const { body } = await built();
    for (const item of body.rigs[0].items) {
      expect(item.imageUrl).toMatch(/^https:\/\//);
      expect(item.image).toBe(item.imageUrl);
      expect(item.productUrl).toMatch(/^\/products\/[^/]+$/);
      expect(item.url).toBe(item.productUrl);
      expect(item).toHaveProperty("vendor");
      expect(item.facts.length).toBeGreaterThan(0);
      expect(item.facts[0]).toEqual(
        expect.objectContaining({ label: expect.any(String), value: expect.any(String) }),
      );
      expect(item.price).toMatch(/^\d+\.\d{2}$/);
      expect(item.currency).not.toBe("");
    }
    const sail = body.rigs[0].items.find((i: Json) => i.role === "sail");
    expect(sail.facts).toContainEqual(
      expect.objectContaining({ label: "Sail area", value: expect.stringMatching(/ m²$/) }),
    );
  });

  it("alternatives carry them too", async () => {
    const { body } = await built();
    expect(body.rigs[0].alternatives.length).toBeGreaterThan(0);
    for (const alternative of body.rigs[0].alternatives) {
      expect(alternative.productId).toMatch(/^gid:/);
      expect(alternative.productUrl).toMatch(/^\/products\//);
      expect(alternative.imageUrl).toMatch(/^https:\/\//);
      expect(alternative.specs).toBeTypeOf("object");
      expect(alternative.facts).toBeInstanceOf(Array);
      expect(alternative).toHaveProperty("vendor");
    }
  });

  it("speaks Slovenian when asked", async () => {
    const ctx = setup();
    const body = await read(
      await ctx.api.build(post({ answers: REFERENCE, locale: "sl" })),
    );
    const sail = body.rigs[0].items.find((i: Json) => i.role === "sail");
    expect(sail.facts[0].label).toBe("Površina jadra");
  });

  it("never exposes cost or another internal id", async () => {
    const { body } = await built();
    const text = JSON.stringify(body.rigs);
    expect(text).not.toMatch(/cost|shopId|variantGid|priceMinor|inventory/i);
  });
});

describe("breadcrumbs", () => {
  function withCrumbs() {
    const crumbs: RigCall[] = [];
    const ctx = setup({ breadcrumb: (call) => crumbs.push(call) });
    return { ...ctx, crumbs };
  }

  it("one per build, explain and verify, with ids, counts and status", async () => {
    const { api, crumbs } = withCrumbs();
    const body = await read(await api.build(post({ answers: REFERENCE })));
    await api.explain(post({ answers: REFERENCE }));
    await api.verify(
      post({
        variantIds: body.rigs[0].items.map((i: Json) => i.variantId),
        answers: REFERENCE,
      }),
    );
    expect(crumbs.map((c) => [c.route, c.status])).toEqual([
      ["build", 200],
      ["explain", 200],
      ["verify", 200],
    ]);
    expect(crumbs[0]).toEqual(
      expect.objectContaining({ requestId: body.requestId, mode: "plain", parts: 6 }),
    );
    expect(crumbs[1]?.mode).toMatch(/^(ai|plain)$/);
    expect(crumbs[2]).toEqual(expect.objectContaining({ parts: 6, failedChecks: 0 }));
    expect(typeof crumbs[0]?.latencyMs).toBe("number");
  });

  it("records refusals by status and code", async () => {
    const { api, crumbs } = withCrumbs();
    await api.build(post({ answers: { weightKg: 0 } }));
    await api.build(post("not json"));
    expect(crumbs.map((c) => [c.status, c.code])).toEqual([
      [400, "invalid_body"],
      [400, "invalid_json"],
    ]);
  });

  it("never carries the buyer's text or address", async () => {
    const { api, crumbs } = withCrumbs();
    await api.explain(
      post({ text: "I am Marta Novak, 82 kg, 15 to 25 knots" }, { "X-Forwarded-For": "198.51.100.7" }),
    );
    const text = JSON.stringify(crumbs);
    expect(text).not.toMatch(/Marta|198\.51|82 kg/);
  });

  it("a breadcrumb that throws changes nothing", async () => {
    const ctx = setup({
      breadcrumb: () => {
        throw new Error("sentry is down");
      },
    });
    const response = await ctx.api.build(post({ answers: REFERENCE }));
    expect(response.status).toBe(200);
  });
});
