import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { metafieldsFrom } from "~/adapters/db/repositories/catalogue.server";
import type { ImportPlan, PlannedChange } from "~/domain/values/import";
import { LIMITS, type ValuesProduct } from "~/domain/values/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Bulk attribute values in the database (docs/attributes.md § Bulk values):
 * the catalogue as the export and the import read it, and the stored
 * previews with their outcomes. Every query carries the shop; an id from
 * another shop finds nothing.
 */

async function shopIdOf(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

export interface LightProduct {
  productId: string;
  productType: string | null;
  categoryName: string | null;
  chosenTypeId: string | null;
  variantCount: number;
}

/** Every product's type facts and variant count, without the heavy columns. */
export async function listLightProducts(
  principal: Principal,
): Promise<LightProduct[]> {
  const shopId = await shopIdOf(principal);
  const [rows, assignments] = await Promise.all([
    prisma.catalogProduct.findMany({
      where: { shopId },
      select: {
        shopifyProductId: true,
        productType: true,
        categoryName: true,
        _count: { select: { variants: true } },
      },
    }),
    prisma.productTypeAssignment.findMany({
      where: { shopId },
      select: { productId: true, typeId: true },
    }),
  ]);
  const chosen = new Map(assignments.map((a) => [a.productId, a.typeId]));
  return rows.map((row) => ({
    productId: row.shopifyProductId,
    productType: row.productType,
    categoryName: row.categoryName,
    chosenTypeId: chosen.get(row.shopifyProductId) ?? null,
    variantCount: row._count.variants,
  }));
}

const PLACEHOLDER = "Default Title";
const CHUNK = 400;

function optionValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const value = (entry as { value?: unknown }).value;
    return typeof value === "string" && value !== PLACEHOLDER ? [value] : [];
  });
}

/**
 * These products with their variants, from the snapshot. A variant id
 * names its product, so a file that carries only variant ids reads the
 * right products.
 */
export async function loadValuesProducts(
  principal: Principal,
  ids: { productIds?: readonly string[]; variantIds?: readonly string[] },
): Promise<ValuesProduct[]> {
  const shopId = await shopIdOf(principal);
  const productIds = new Set(ids.productIds ?? []);
  const variantIds = [...new Set(ids.variantIds ?? [])];
  for (let start = 0; start < variantIds.length; start += CHUNK) {
    const rows = await prisma.catalogVariant.findMany({
      where: {
        shopId,
        shopifyVariantId: { in: variantIds.slice(start, start + CHUNK) },
      },
      select: { product: { select: { shopifyProductId: true } } },
    });
    for (const row of rows) productIds.add(row.product.shopifyProductId);
  }
  const wanted = [...productIds];
  const assignments = new Map<string, string>();
  const products: ValuesProduct[] = [];
  for (let start = 0; start < wanted.length; start += CHUNK) {
    const chunk = wanted.slice(start, start + CHUNK);
    const [rows, assigned] = await Promise.all([
      prisma.catalogProduct.findMany({
        where: { shopId, shopifyProductId: { in: chunk } },
        include: { variants: { orderBy: { shopifyVariantId: "asc" } } },
      }),
      prisma.productTypeAssignment.findMany({
        where: { shopId, productId: { in: chunk } },
        select: { productId: true, typeId: true },
      }),
    ]);
    for (const a of assigned) assignments.set(a.productId, a.typeId);
    for (const row of rows)
      products.push({
        productId: row.shopifyProductId,
        title: row.title,
        vendor: row.vendor ?? "",
        productType: row.productType,
        categoryName: row.categoryName,
        chosenTypeId: assignments.get(row.shopifyProductId) ?? null,
        metafields: metafieldsFrom(row.metafields),
        variants: row.variants.map((variant) => ({
          variantId: variant.shopifyVariantId,
          sku: variant.sku,
          title: variant.title ?? "",
          options: optionValues(variant.options),
          metafields: metafieldsFrom(variant.metafields),
        })),
      });
  }
  return products;
}

/* -------------------------------------------------------------------------- */
/* Stored previews                                                            */
/* -------------------------------------------------------------------------- */

const storedValue = z.object({ type: z.string(), value: z.string() });

const changeSchema = z.object({
  row: z.number(),
  ownerId: z.string(),
  productId: z.string(),
  scope: z.enum(["product", "variant"]),
  attributeId: z.string(),
  name: z.string(),
  namespace: z.string(),
  key: z.string(),
  kind: z.enum([
    "text",
    "multiline",
    "integer",
    "decimal",
    "boolean",
    "date",
    "choice",
    "choices",
    "measurement",
  ]),
  shopifyType: z.string(),
  op: z.enum(["set", "clear"]),
  value: z.string().nullable(),
  before: storedValue.nullable(),
  beforeCanon: z.string(),
  afterCanon: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
  defined: z.boolean(),
});

const changesSchema = z.array(changeSchema);

/** What one change came to. `failed:` carries Shopify's words. */
export type ChangeOutcome =
  | "written"
  | "cleared"
  | "unchanged"
  | "changed_meanwhile"
  | "gone"
  | `failed:${string}`;

const outcomesSchema = z.array(z.string().nullable());

export type ImportStatus =
  | "previewed"
  | "queued"
  | "running"
  | "done"
  | "failed";

/** The plan without its changes: what the page shows. */
export type ImportSummary = Omit<ImportPlan, "changes">;

export interface StoredImport {
  id: string;
  fileName: string;
  status: ImportStatus;
  expired: boolean;
  expiresAt: Date;
  summary: ImportSummary;
  total: number;
  done: number;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  appliedBy: string | null;
}

/** An apply that has not moved for this long is taken to have died. */
export const IMPORT_STALE_MS = 30 * 60 * 1000;

const STALE_MESSAGE =
  "The import stopped without finishing, most likely because the app restarted while it worked. Values already written are kept; press Continue to finish the rest.";

function statusOf(value: string): ImportStatus {
  return value === "previewed" ||
    value === "queued" ||
    value === "running" ||
    value === "done"
    ? value
    : "failed";
}

function toStored(
  row: Prisma.BulkValueImportGetPayload<{
    select: {
      id: true;
      fileName: true;
      status: true;
      expiresAt: true;
      summary: true;
      total: true;
      done: true;
      lastError: true;
      createdAt: true;
      startedAt: true;
      finishedAt: true;
      appliedBy: true;
    };
  }>,
): StoredImport {
  return {
    id: row.id,
    fileName: row.fileName,
    status: statusOf(row.status),
    expired: row.status === "previewed" && row.expiresAt < new Date(),
    expiresAt: row.expiresAt,
    summary: row.summary as unknown as ImportSummary,
    total: row.total,
    done: row.done,
    lastError: row.lastError,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    appliedBy: row.appliedBy,
  };
}

const SELECT = {
  id: true,
  fileName: true,
  status: true,
  expiresAt: true,
  summary: true,
  total: true,
  done: true,
  lastError: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  appliedBy: true,
} as const;

async function failStale(shopId: string): Promise<void> {
  await prisma.bulkValueImport.updateMany({
    where: {
      shopId,
      status: { in: ["queued", "running"] },
      updatedAt: { lt: new Date(Date.now() - IMPORT_STALE_MS) },
    },
    data: {
      status: "failed",
      lastError: STALE_MESSAGE,
      finishedAt: new Date(),
    },
  });
}

export async function createImport(
  principal: Principal,
  input: { fileName: string; createdBy: string | null; plan: ImportPlan },
): Promise<string> {
  const shopId = await shopIdOf(principal);
  // Previews nobody applied are dropped after their day, here, where the
  // next one is made; a preview being applied is never touched.
  await prisma.bulkValueImport.deleteMany({
    where: { shopId, status: "previewed", expiresAt: { lt: new Date() } },
  });
  const { changes, ...summary } = input.plan;
  const row = await prisma.bulkValueImport.create({
    data: {
      shopId,
      fileName: input.fileName.slice(0, 200),
      createdBy: input.createdBy,
      status: "previewed",
      expiresAt: new Date(Date.now() + LIMITS.previewHours * 3_600_000),
      summary: summary as unknown as Prisma.InputJsonValue,
      changes: changes as unknown as Prisma.InputJsonValue,
      outcomes: [],
      total: changes.length,
    },
    select: { id: true },
  });
  return row.id;
}

/** One import of this shop, or null: another shop's id finds nothing. */
export async function getImport(
  principal: Principal,
  id: string,
): Promise<StoredImport | null> {
  const shopId = await shopIdOf(principal);
  await failStale(shopId);
  const row = await prisma.bulkValueImport.findFirst({
    where: { id, shopId },
    select: SELECT,
  });
  return row ? toStored(row) : null;
}

/** The shop's latest import that is still worth showing. */
export async function latestImport(
  principal: Principal,
): Promise<StoredImport | null> {
  const shopId = await shopIdOf(principal);
  await failStale(shopId);
  const row = await prisma.bulkValueImport.findFirst({
    where: {
      shopId,
      OR: [
        { status: { not: "previewed" } },
        { expiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
  return row ? toStored(row) : null;
}

export async function discardImport(
  principal: Principal,
  id: string,
): Promise<boolean> {
  const shopId = await shopIdOf(principal);
  const { count } = await prisma.bulkValueImport.deleteMany({
    where: { id, shopId, status: { in: ["previewed", "done", "failed"] } },
  });
  return count > 0;
}

export type ClaimResult =
  | { ok: true }
  | {
      ok: false;
      reason: "unknown" | "expired" | "busy" | "already" | "nothing";
    };

/**
 * Takes a preview for applying: one at a time per shop, only a preview that
 * has not expired, only one with something to write. A failed one is taken
 * again to carry on where it stopped.
 */
export async function claimApply(
  principal: Principal,
  id: string,
  by: string | null,
): Promise<ClaimResult> {
  const shopId = await shopIdOf(principal);
  await failStale(shopId);
  const row = await prisma.bulkValueImport.findFirst({
    where: { id, shopId },
    select: { status: true, expiresAt: true, total: true, summary: true },
  });
  if (!row) return { ok: false, reason: "unknown" };
  if (row.status === "queued" || row.status === "running" || row.status === "done")
    return { ok: false, reason: "already" };
  if (row.status === "previewed" && row.expiresAt < new Date())
    return { ok: false, reason: "expired" };
  const summary = row.summary as unknown as ImportSummary;
  if (row.status === "previewed" && (!summary.safeToApply || row.total === 0))
    return { ok: false, reason: "nothing" };
  const other = await prisma.bulkValueImport.findFirst({
    where: { shopId, id: { not: id }, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (other) return { ok: false, reason: "busy" };
  const claimed = await prisma.bulkValueImport.updateMany({
    where: { id, shopId, status: { in: ["previewed", "failed"] } },
    data: {
      status: "queued",
      lastError: null,
      appliedBy: by,
      finishedAt: null,
      // Extended so the day it was valid for does not end part way.
      expiresAt: new Date(Date.now() + LIMITS.previewHours * 3_600_000),
    },
  });
  return claimed.count === 1 ? { ok: true } : { ok: false, reason: "already" };
}

export interface RunningImport {
  id: string;
  changes: PlannedChange[];
  outcomes: Array<string | null>;
}

/** The job's own start: the import is `running`, with its changes and what is done. */
export async function startRun(
  shopDomain: string,
  id: string,
): Promise<RunningImport | null> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return null;
  const claimed = await prisma.bulkValueImport.updateMany({
    where: { id, shopId: shop.id, status: { in: ["queued", "running"] } },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  const row = await prisma.bulkValueImport.findFirst({
    where: { id, shopId: shop.id },
    select: { id: true, changes: true, outcomes: true },
  });
  if (!row) return null;
  const changes = changesSchema.parse(row.changes);
  const parsed = outcomesSchema.safeParse(row.outcomes);
  const outcomes = parsed.success ? parsed.data : [];
  while (outcomes.length < changes.length) outcomes.push(null);
  return { id: row.id, changes, outcomes };
}

export async function saveProgress(
  shopDomain: string,
  id: string,
  outcomes: ReadonlyArray<string | null>,
): Promise<void> {
  await prisma.bulkValueImport.updateMany({
    where: { id, shop: { domain: shopDomain }, status: "running" },
    data: {
      outcomes: outcomes as unknown as Prisma.InputJsonValue,
      done: outcomes.filter((o) => o !== null).length,
    },
  });
}

export async function finishRun(
  shopDomain: string,
  id: string,
  result: { status: "done" | "failed"; lastError?: string | null },
): Promise<void> {
  await prisma.bulkValueImport.updateMany({
    where: { id, shop: { domain: shopDomain } },
    data: {
      status: result.status,
      lastError: result.lastError ?? null,
      finishedAt: new Date(),
    },
  });
}

/** The outcomes of an import, counted for the result and the audit event. */
export interface OutcomeCounts {
  written: number;
  cleared: number;
  unchanged: number;
  changedMeanwhile: number;
  gone: number;
  failed: number;
  waiting: number;
}

export function countOutcomes(
  outcomes: ReadonlyArray<string | null>,
): OutcomeCounts {
  const counts: OutcomeCounts = {
    written: 0,
    cleared: 0,
    unchanged: 0,
    changedMeanwhile: 0,
    gone: 0,
    failed: 0,
    waiting: 0,
  };
  for (const outcome of outcomes) {
    if (outcome === null) counts.waiting += 1;
    else if (outcome === "written") counts.written += 1;
    else if (outcome === "cleared") counts.cleared += 1;
    else if (outcome === "unchanged") counts.unchanged += 1;
    else if (outcome === "changed_meanwhile") counts.changedMeanwhile += 1;
    else if (outcome === "gone") counts.gone += 1;
    else counts.failed += 1;
  }
  return counts;
}

export interface ChangeReport {
  row: number;
  product: string;
  attribute: string;
  outcome: string;
}

/** The outcomes that need a person: the first few changed meanwhile, gone and failed. */
export async function importProblems(
  principal: Principal,
  id: string,
  limit = LIMITS.errorsShown,
): Promise<{ counts: OutcomeCounts; problems: ChangeReport[] } | null> {
  const shopId = await shopIdOf(principal);
  const row = await prisma.bulkValueImport.findFirst({
    where: { id, shopId },
    select: { changes: true, outcomes: true },
  });
  if (!row) return null;
  const changes = changesSchema.safeParse(row.changes);
  const outcomes = outcomesSchema.safeParse(row.outcomes);
  if (!changes.success || !outcomes.success) return null;
  const problems: ChangeReport[] = [];
  changes.data.forEach((change, i) => {
    const outcome = outcomes.data[i];
    if (
      outcome &&
      outcome !== "written" &&
      outcome !== "cleared" &&
      outcome !== "unchanged" &&
      problems.length < limit
    )
      problems.push({
        row: change.row,
        product: change.productId,
        attribute: change.name,
        outcome,
      });
  });
  return { counts: countOutcomes(outcomes.data), problems };
}

/* -------------------------------------------------------------------------- */
/* Mirroring writes into the snapshot                                         */
/* -------------------------------------------------------------------------- */

export interface MirrorWrite {
  ownerId: string;
  scope: "product" | "variant";
  /** `namespace.key`. */
  name: string;
  /** The value now, or null when removed. */
  stored: { type: string; value: string } | null;
}

/**
 * Keeps the catalogue's copy of a metafield in step with what was just
 * written to Shopify, so the next export, preview and the rig builder read
 * it without waiting for a snapshot. One owner's row is changed in one
 * transaction.
 */
export async function mirrorMetafields(
  shopDomain: string,
  writes: readonly MirrorWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  const owners = new Map<string, MirrorWrite[]>();
  for (const write of writes) {
    const key = `${write.scope}|${write.ownerId}`;
    owners.set(key, [...(owners.get(key) ?? []), write]);
  }
  for (const list of owners.values()) {
    const first = list[0];
    if (!first) continue;
    await prisma.$transaction(async (tx) => {
      const merge = (current: Prisma.JsonValue | null) => {
        const map = metafieldsFrom(current);
        for (const write of list) {
          if (write.stored) map[write.name] = write.stored;
          else delete map[write.name];
        }
        return map as unknown as Prisma.InputJsonValue;
      };
      if (first.scope === "variant") {
        const row = await tx.catalogVariant.findFirst({
          where: { shopId: shop.id, shopifyVariantId: first.ownerId },
          select: { id: true, metafields: true },
        });
        if (row)
          await tx.catalogVariant.update({
            where: { id: row.id },
            data: { metafields: merge(row.metafields) },
          });
      } else {
        const row = await tx.catalogProduct.findFirst({
          where: { shopId: shop.id, shopifyProductId: first.ownerId },
          select: { id: true, metafields: true },
        });
        if (row)
          await tx.catalogProduct.update({
            where: { id: row.id },
            data: { metafields: merge(row.metafields) },
          });
      }
    });
  }
}
