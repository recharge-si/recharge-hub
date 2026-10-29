import { prisma } from "~/adapters/db/client.server";
import { saveAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { replaceCatalogue } from "~/adapters/db/repositories/catalogue.server";

import { REFERENCE, loadCatalogue, rigPlan } from "../../support/rig-fixtures";
import { BASE_URL } from "../support/env";
import { ownerOf } from "../support/seed";
import { expect, test, type TestShop } from "../support/test";

/**
 * The three routes behind the Shopify App Proxy, end to end through the real
 * app build (docs/rig-builder.md § Contract): /proxy/rig/build, /explain and
 * /verify. The e2e Shopify module answers `authenticate.public.appProxy` for
 * requests that carry the fixed signature below; the catalogue is the unit
 * fixture (tests/fixtures/rig/catalogue.json, shop A) written into the shop's
 * snapshot tables. No model runs: explain answers in plain wording because
 * no claude CLI exists in the e2e stack.
 */

const SIGNATURE = "e2e-proxy-ok";

// A response body the specs index freely; the shapes are asserted by the specs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function url(shop: TestShop, route: "build" | "explain" | "verify", signed = true) {
  const query = new URLSearchParams({ shop: shop.domain, timestamp: "1" });
  if (signed) query.set("signature", SIGNATURE);
  return `${BASE_URL}/proxy/rig/${route}?${query.toString()}`;
}

/** A distinct client address per test, so the rate limiter never crosses tests. */
const ip = () =>
  `203.0.113.${1 + Math.floor(Math.random() * 250)}, 10.0.0.${Math.floor(Math.random() * 250)}`;

async function call(
  shop: TestShop,
  route: "build" | "explain" | "verify",
  body: unknown,
  headers: Record<string, string> = {},
  signed = true,
) {
  const response = await fetch(url(shop, route, signed), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as Json };
}

async function enable(shop: TestShop, enabled = true) {
  await prisma.shop.update({
    where: { id: shop.id },
    data: { rigBuilderEnabled: enabled },
  });
}

/** Shop A of the unit fixture as this shop's catalogue snapshot, stock included. */
async function seedRigCatalogue(shop: TestShop) {
  const owner = ownerOf(shop);
  await saveAttributeSchema(owner, rigPlan(), 0);
  const products = loadCatalogue().filter((p) => p.shopId === "shop-a");
  await replaceCatalogue(
    owner,
    products.map((product) => ({
      productId: product.productId,
      title: product.title,
      handle: product.handle,
      onlineStoreUrl: null,
      description: null,
      vendor: product.vendor ?? null,
      productType: product.productType,
      status: product.status ?? "ACTIVE",
      tags: [],
      collectionIds: [],
      categoryId: null,
      categoryName: product.categoryName,
      imageUrl: product.imageUrl,
      shopifyUpdatedAt: new Date().toISOString(),
      metafields: product.metafields,
      variants: product.variants.map((variant) => ({
        variantId: variant.variantId,
        productId: product.productId,
        sku: null,
        barcode: null,
        title: variant.title,
        priceMinor: variant.priceMinor,
        compareAtMinor: null,
        options: [...(variant.options ?? [])],
        inventoryQuantity: variant.inventoryQuantity,
        availableForSale: variant.availableForSale,
        metafields: variant.metafields,
      })),
    })),
    "EUR",
    new Date(),
  );
}

const ROUTES = ["build", "explain", "verify"] as const;

test("a request without Shopify's signature is a 401 on every route", async ({ shop }) => {
  await enable(shop);
  for (const route of ROUTES) {
    const refused = await call(shop, route, { answers: REFERENCE, variantIds: [1] }, {}, false);
    expect(refused.status, route).toBe(401);
    expect(refused.body).toEqual({ code: "unauthorized" });
  }
});

test("not ready is a 409 the page can read: disabled, then an empty catalogue", async ({ shop }) => {
  const off = await call(shop, "build", { answers: REFERENCE });
  expect(off.status).toBe(409);
  expect(off.body).toMatchObject({ code: "not_ready", reason: "disabled" });

  await enable(shop);
  for (const route of ROUTES) {
    const body = route === "verify" ? { variantIds: [1] } : { answers: REFERENCE };
    const empty = await call(shop, route, body);
    expect(empty.status, route).toBe(409);
    expect(empty.body, route).toMatchObject({ code: "not_ready", reason: "catalogue" });
  }
});

test("a bad body is a 400 with the field named, before anything is read", async ({ shop }) => {
  await enable(shop);
  const nothing = await call(shop, "build", {});
  expect(nothing.status).toBe(400);
  expect(nothing.body).toMatchObject({ code: "invalid_body" });

  const weight = await call(shop, "build", { answers: { weightKg: 0 } });
  expect(weight.status).toBe(400);
  expect(weight.body.field).toContain("weightKg");

  const tooMany = await call(shop, "build", {
    answers: REFERENCE,
    excludeVariantIds: Array.from({ length: 51 }, (_, i) => i + 1),
  });
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.field).toContain("excludeVariantIds");

  const none = await call(shop, "verify", { variantIds: [] });
  expect(none.status).toBe(400);
  const unknown = await call(shop, "explain", { answers: REFERENCE, surprise: true });
  expect(unknown.status).toBe(400);
});

test("a build with a ready catalogue answers a rig, stores the request and honours excludeVariantIds", async ({
  shop,
}) => {
  await seedRigCatalogue(shop);
  await enable(shop);

  const built = await call(shop, "build", { answers: REFERENCE });
  expect(built.status).toBe(200);
  expect(built.body["requestId"]).toMatch(/^rb_[0-9a-f]{24}$/);
  const items = built.body["rigs"][0].items as Array<Json>;
  expect(items.map((i) => i.role).sort()).toEqual(
    ["base", "board", "boom", "fin", "mast", "sail"],
  );
  for (const item of items) {
    expect(item.productUrl).toMatch(/^\/products\//);
    expect(item.imageUrl).toMatch(/^https:\/\//);
    expect(item.facts.length).toBeGreaterThan(0);
  }
  expect(built.body["rigs"][0].checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  expect(
    await prisma.rigRequest.count({ where: { shopId: shop.id } }),
  ).toBe(1);

  // The cart refused the sail as sold out: rebuild without it.
  const sail = items.find((i) => i.role === "sail")!.variantId as number;
  const again = await call(shop, "build", { answers: REFERENCE, excludeVariantIds: [sail] });
  expect(again.status).toBe(200);
  const rebuilt = [
    ...again.body["rigs"][0].items,
    ...again.body["rigs"][0].alternatives,
  ].map((p: { variantId: number }) => p.variantId);
  expect(rebuilt).not.toContain(sail);
});

test("explain answers in plain wording without a model, and verify checks a rig", async ({ shop }) => {
  await seedRigCatalogue(shop);
  await enable(shop);

  const explained = await call(shop, "explain", { answers: REFERENCE });
  expect(explained.status).toBe(200);
  expect(explained.body["mode"]).toBe("plain");
  const ids = explained.body["variantIds"] as number[];
  expect(ids.length).toBe(6);
  expect(Object.keys(explained.body["whys"]).sort()).toEqual(ids.map(String).sort());

  const verified = await call(shop, "verify", { variantIds: ids, answers: REFERENCE });
  expect(verified.status).toBe(200);
  expect(verified.body["ok"]).toBe(true);

  const refused = await call(shop, "verify", {
    variantIds: ids,
    answers: REFERENCE,
    excludeVariantIds: [ids[0]],
  });
  expect(refused.body["ok"]).toBe(false);
  expect(refused.body["checks"]).toContainEqual({
    id: `excluded-variant-${ids[0]}`,
    ok: false,
  });
});

test("the 61st build in a minute from one address is a 429 with Retry-After", async ({ shop }) => {
  await enable(shop);
  const same = { "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` };
  for (let i = 0; i < 60; i += 1) {
    const response = await call(shop, "build", {}, same);
    expect(response.status).toBe(400);
  }
  const limited = await call(shop, "build", {}, same);
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({ code: "rate_limited" });
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
});
