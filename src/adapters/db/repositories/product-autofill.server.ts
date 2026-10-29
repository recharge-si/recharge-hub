import type { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import {
  autofillValuesCodec,
  type AutofillValue,
} from "~/domain/products/autofill";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * What AI autofill suggested, per product (docs/attributes.md § AI
 * autofill). One row per shop and product: asking again replaces the
 * suggestion, applying or discarding it closes it. The row is the review
 * queue's state; nothing in it has reached Shopify.
 */

export type AutofillStatus =
  "queued" | "running" | "ready" | "applied" | "discarded" | "failed";

export interface AutofillState {
  productId: string;
  status: AutofillStatus;
  typeId: string | null;
  typeOrigin: "suggested" | "kept" | null;
  typeConfidence: number | null;
  typeReason: string | null;
  values: AutofillValue[];
  engine: string | null;
  /** `export-portal` or `claude-pool`; null on rows made before it was recorded. */
  source: string | null;
  /** The model that answered, when the producer reports one. */
  model: string | null;
  error: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
}

const STATUSES: readonly AutofillStatus[] = [
  "queued",
  "running",
  "ready",
  "applied",
  "discarded",
  "failed",
];

type Row = Prisma.ProductAutofillGetPayload<object>;

function stateOf(row: Row): AutofillState {
  const values = autofillValuesCodec.safeParse(row.values);
  return {
    productId: row.productId,
    status: (STATUSES as readonly string[]).includes(row.status)
      ? (row.status as AutofillStatus)
      : "failed",
    typeId: row.typeId,
    typeOrigin:
      row.typeOrigin === "suggested" || row.typeOrigin === "kept"
        ? row.typeOrigin
        : null,
    typeConfidence: row.typeConfidence,
    typeReason: row.typeReason,
    values: values.success ? values.data : [],
    engine: row.engine,
    source: row.source,
    model: row.model,
    error: row.error,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
  };
}

async function shopIdOf(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

const scoped = (principal: Principal) => ({
  shop: { domain: shopDomainOf(principal) },
});

/**
 * How long a product may sit before it is taken to be lost. Running: a pass
 * is ten products, each a call or two of at most ninety seconds. Queued: a
 * long request waits its turn behind passes of ten.
 */
export const AUTOFILL_STALE_MS = {
  running: 30 * 60 * 1000,
  queued: 4 * 60 * 60 * 1000,
};

/**
 * Marks failed the products whose suggestion will never come: their job
 * died with its worker, expired, or never ran. Read paths call this first,
 * so no page shows "Autofilling…" for ever and the product can be asked again.
 */
export async function failStaleAutofills(principal: Principal): Promise<void> {
  const now = Date.now();
  await prisma.productAutofill.updateMany({
    where: {
      ...scoped(principal),
      OR: [
        {
          status: "running",
          updatedAt: { lt: new Date(now - AUTOFILL_STALE_MS.running) },
        },
        {
          status: "queued",
          updatedAt: { lt: new Date(now - AUTOFILL_STALE_MS.queued) },
        },
      ],
    },
    data: {
      status: "failed",
      error:
        "No answer came back, most likely because the app restarted while it worked. Ask again.",
    },
  });
}

export async function getAutofill(
  principal: Principal,
  productId: string,
): Promise<AutofillState | null> {
  await failStaleAutofills(principal);
  const row = await prisma.productAutofill.findFirst({
    where: { ...scoped(principal), productId },
  });
  return row ? stateOf(row) : null;
}

export async function listAutofills(
  principal: Principal,
  productIds: readonly string[],
): Promise<Map<string, AutofillState>> {
  if (productIds.length === 0) return new Map();
  await failStaleAutofills(principal);
  const rows = await prisma.productAutofill.findMany({
    where: { ...scoped(principal), productId: { in: [...productIds] } },
  });
  return new Map(rows.map((row) => [row.productId, stateOf(row)]));
}

/**
 * Ready suggestions for products that still exist, newest first. A product
 * deleted in Shopify has left the catalogue snapshot; its suggestion has
 * nothing to apply to and is not counted.
 */
async function readyIdsInCatalogue(principal: Principal): Promise<string[]> {
  const rows = await prisma.productAutofill.findMany({
    where: { ...scoped(principal), status: "ready" },
    select: { productId: true },
    orderBy: { updatedAt: "desc" },
  });
  if (rows.length === 0) return [];
  const present = await prisma.catalogProduct.findMany({
    where: {
      ...scoped(principal),
      shopifyProductId: { in: rows.map((row) => row.productId) },
    },
    select: { shopifyProductId: true },
  });
  const ids = new Set(present.map((row) => row.shopifyProductId));
  return rows.map((row) => row.productId).filter((id) => ids.has(id));
}

/**
 * The next suggestions waiting for a person, after `after` in product id
 * order: what "apply all" works through a pass at a time. A suggestion that
 * could not be applied stays waiting, so the walk goes by id rather than
 * starting over, and cannot loop on it.
 */
export async function nextReadyAutofills(
  principal: Principal,
  after: string | null,
  limit: number,
): Promise<string[]> {
  return (await readyIdsInCatalogue(principal))
    .filter((id) => after === null || id > after)
    .sort()
    .slice(0, limit);
}

/** Suggestions waiting for a person, for a count on the review page. */
export async function countReadyAutofills(
  principal: Principal,
): Promise<number> {
  return (await readyIdsInCatalogue(principal)).length;
}

/** A product deleted in Shopify takes its suggestion with it. */
export async function forgetAutofill(
  principal: Principal,
  productId: string,
): Promise<void> {
  await prisma.productAutofill.deleteMany({
    where: { ...scoped(principal), productId },
  });
}

const blank = {
  typeId: null,
  typeOrigin: null,
  typeConfidence: null,
  typeReason: null,
  values: [],
  engine: null,
  source: null,
  model: null,
  error: null,
  decidedBy: null,
  decidedAt: null,
};

/**
 * Puts products in the queue, replacing whatever was suggested before. A
 * product already queued or being worked on is left as it is, so pressing
 * twice asks once; the ids actually queued are returned.
 */
export async function queueAutofills(
  principal: Principal,
  productIds: readonly string[],
  requestedBy: string | null,
): Promise<string[]> {
  const shopId = await shopIdOf(principal);
  const busy = new Set(
    (
      await prisma.productAutofill.findMany({
        where: {
          shopId,
          productId: { in: [...productIds] },
          status: { in: ["queued", "running"] },
        },
        select: { productId: true },
      })
    ).map((row) => row.productId),
  );
  const queued = productIds.filter((id) => !busy.has(id));
  const now = new Date();
  for (const productId of queued)
    await prisma.productAutofill.upsert({
      where: { shopId_productId: { shopId, productId } },
      create: {
        shopId,
        productId,
        status: "queued",
        requestedBy,
        requestedAt: now,
      },
      update: { ...blank, status: "queued", requestedBy, requestedAt: now },
    });
  return queued;
}

export async function markAutofillRunning(
  principal: Principal,
  productId: string,
): Promise<void> {
  await prisma.productAutofill.updateMany({
    where: { ...scoped(principal), productId },
    data: { status: "running" },
  });
}

export async function saveAutofillSuggestion(
  principal: Principal,
  productId: string,
  suggestion: {
    typeId: string | null;
    typeOrigin: "suggested" | "kept" | null;
    typeConfidence: number | null;
    typeReason: string | null;
    values: AutofillValue[];
    engine: string;
    /** Defaults to the engine. */
    source?: string;
    /** The model the producer reports, if it does. */
    model?: string | null;
  },
): Promise<void> {
  const shopId = await shopIdOf(principal);
  const data = {
    ...suggestion,
    source: suggestion.source ?? suggestion.engine,
    model: suggestion.model ?? null,
    values: suggestion.values as unknown as Prisma.InputJsonValue,
    status: "ready",
    error: null,
    decidedBy: null,
    decidedAt: null,
  };
  await prisma.productAutofill.upsert({
    where: { shopId_productId: { shopId, productId } },
    create: { shopId, productId, ...data },
    update: data,
  });
}

export async function failAutofill(
  principal: Principal,
  productId: string,
  error: string,
  source: string | null = null,
): Promise<void> {
  const shopId = await shopIdOf(principal);
  await prisma.productAutofill.upsert({
    where: { shopId_productId: { shopId, productId } },
    create: { shopId, productId, status: "failed", error, source },
    update: { ...blank, status: "failed", error, source },
  });
}

/**
 * A producer asked and found nothing to suggest. Recorded as decided, so the
 * review queue does not show it and a resumed run does not ask again.
 */
export async function recordNothingSuggested(
  principal: Principal,
  productId: string,
  producer: { source: string; model: string | null },
  typeId: string | null,
): Promise<void> {
  const shopId = await shopIdOf(principal);
  const data = {
    ...blank,
    status: "discarded",
    typeId,
    typeOrigin: typeId ? "kept" : null,
    engine: producer.source,
    source: producer.source,
    model: producer.model,
    decidedBy: producer.source,
    decidedAt: new Date(),
  };
  await prisma.productAutofill.upsert({
    where: { shopId_productId: { shopId, productId } },
    create: { shopId, productId, ...data },
    update: data,
  });
}

/**
 * Closes a suggestion that is still waiting. Refused (false) when it is
 * not, so a second tab cannot apply what the first already discarded.
 */
export async function decideAutofill(
  principal: Principal,
  productId: string,
  status: "applied" | "discarded",
  decidedBy: string | null,
): Promise<boolean> {
  const closed = await prisma.productAutofill.updateMany({
    where: { ...scoped(principal), productId, status: "ready" },
    data: { status, decidedBy, decidedAt: new Date() },
  });
  return closed.count > 0;
}

/** Products whose suggestions wait for a person, newest first, at most `limit`. */
export async function readyAutofillProductIds(
  principal: Principal,
  limit = 1000,
): Promise<string[]> {
  return (await readyIdsInCatalogue(principal)).slice(0, limit);
}

/**
 * What says the AI has been asked about a product, or is being: such a
 * product is passed over by "autofill all", so a second run resumes
 * rather than asking again, and a suggestion waiting or decided is never
 * overwritten. A failed one is asked again.
 */
const ASKED = ["queued", "running", "ready", "applied", "discarded"];

/** Catalogue products read per look-up while walking it. */
const WALK_PAGE = 200;

/**
 * The next products of the catalogue the AI has not been asked about,
 * after `after` in product id order, and where the walk goes on from
 * (null at the end). Read a pass at a time, so a product is marked queued
 * only when its turn comes and never waits long enough to look lost.
 */
export async function nextUnaskedProducts(
  principal: Principal,
  after: string | null,
  limit: number,
): Promise<{ ids: string[]; next: string | null }> {
  const shopId = await shopIdOf(principal);
  const ids: string[] = [];
  let cursor = after;
  for (;;) {
    const page = await prisma.catalogProduct.findMany({
      where: {
        shopId,
        ...(cursor ? { shopifyProductId: { gt: cursor } } : {}),
      },
      select: { shopifyProductId: true },
      orderBy: { shopifyProductId: "asc" },
      take: WALK_PAGE,
    });
    if (page.length === 0) return { ids, next: null };
    const asked = new Set(
      (
        await prisma.productAutofill.findMany({
          where: {
            shopId,
            productId: { in: page.map((row) => row.shopifyProductId) },
            status: { in: ASKED },
          },
          select: { productId: true },
        })
      ).map((row) => row.productId),
    );
    for (const { shopifyProductId: id } of page) {
      cursor = id;
      if (asked.has(id)) continue;
      ids.push(id);
      if (ids.length === limit) return { ids, next: cursor };
    }
    if (page.length < WALK_PAGE) return { ids, next: null };
  }
}

/** How many catalogue products "autofill all" would ask about. */
export async function countUnaskedProducts(
  principal: Principal,
): Promise<number> {
  const shopId = await shopIdOf(principal);
  const [total, asked] = await Promise.all([
    prisma.catalogProduct.count({ where: { shopId } }),
    prisma.productAutofill.count({
      where: { shopId, status: { in: ASKED } },
    }),
  ]);
  return Math.max(0, total - asked);
}
