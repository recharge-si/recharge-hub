import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  claimApply,
  createImport,
  discardImport,
  finishRun,
  getImport,
  listLightProducts,
  loadValuesProducts,
} from "~/adapters/db/repositories/bulk-values.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES, bulkValuesKey } from "~/adapters/queue/queues";
import { listMetafieldDefinitions } from "~/adapters/shopify/products";
import { parseCsvRows } from "~/domain/attributes/csv";
import { assignableTypes } from "~/domain/products/attribute-values";
import { shopDomainOf, type Principal } from "~/domain/types";
import {
  buildExport,
  countExportRows,
  type Preset,
} from "~/domain/values/export";
import { typeOfProduct } from "~/domain/values/fields";
import { idsInRows, planImport } from "~/domain/values/import";
import { LIMITS } from "~/domain/values/types";

/**
 * The three things the Values page does, apart from the route so they can be
 * held to their rules without a request (docs/attributes.md § Bulk values):
 * the export, the preview of a file, and applying a preview. Nothing here
 * writes to Shopify; the apply job does.
 */

const BOM = String.fromCharCode(0xfeff);

/** The metafield definitions' types, as the product page reads them; empty if Shopify cannot say. */
async function definitionTypes(
  admin: AdminApiContext,
): Promise<Map<string, string>> {
  try {
    const list = await listMetafieldDefinitions(admin);
    return new Map(
      list.flatMap((definition) =>
        definition.type
          ? [
              [
                `${definition.ownerType}|${definition.namespace}.${definition.key}`,
                definition.type,
              ] as const,
            ]
          : [],
      ),
    );
  } catch (error) {
    getLogger().warn(
      { err: error },
      "Metafield definitions could not be read for bulk values",
    );
    return new Map();
  }
}

/* -------------------------------------------------------------------------- */
/* The page's reads                                                           */
/* -------------------------------------------------------------------------- */

export interface TypeChoice {
  typeId: string;
  label: string;
  products: number;
  variants: number;
}

/** The types products can have, with how many products and variants each has. */
export async function typeChoices(principal: Principal): Promise<{
  choices: TypeChoice[];
  catalogueRead: boolean;
}> {
  const [{ schema }, light] = await Promise.all([
    getAttributeSchema(principal),
    listLightProducts(principal),
  ]);
  const counts = new Map<string, { products: number; variants: number }>();
  for (const product of light) {
    const typeId = typeOfProduct(schema, product);
    if (!typeId) continue;
    const entry = counts.get(typeId) ?? { products: 0, variants: 0 };
    entry.products += 1;
    entry.variants += product.variantCount;
    counts.set(typeId, entry);
  }
  return {
    catalogueRead: light.length > 0,
    choices: assignableTypes(schema).flatMap((type) => {
      const entry = counts.get(type.id);
      return entry
        ? [
            {
              typeId: type.id,
              label: type.path.slice(1).join(" › ") || type.name,
              products: entry.products,
              variants: entry.variants,
            },
          ]
        : [];
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

export type ExportOutcome =
  | { ok: true; body: string; fileName: string; rows: number }
  | { ok: false; status: 400 | 413; message: string };

export function parsePreset(value: string | null): Preset {
  return value === "all" ? "all" : "rig";
}

export async function exportValues(
  admin: AdminApiContext,
  principal: Principal,
  request: { typeIds: readonly string[]; preset: Preset },
): Promise<ExportOutcome> {
  const { schema } = await getAttributeSchema(principal);
  const allowed = new Set(assignableTypes(schema).map((type) => type.id));
  const typeIds = [...new Set(request.typeIds)].filter((id) => allowed.has(id));
  if (typeIds.length === 0)
    return {
      ok: false,
      status: 400,
      message: "Choose at least one product type to export.",
    };

  const light = await listLightProducts(principal);
  const rows = countExportRows(schema, typeIds, light);
  if (rows > LIMITS.exportRows)
    return {
      ok: false,
      status: 413,
      message: `That is ${rows.toLocaleString("en")} rows and a file holds at most ${LIMITS.exportRows.toLocaleString("en")}. Choose fewer types.`,
    };
  const wanted = new Set(typeIds);
  const productIds = light
    .filter((product) => {
      const typeId = typeOfProduct(schema, product);
      return typeId !== null && wanted.has(typeId);
    })
    .map((product) => product.productId);
  const [products, definitions] = await Promise.all([
    loadValuesProducts(principal, { productIds }),
    definitionTypes(admin),
  ]);
  const built = buildExport({
    schema,
    definitions,
    typeIds,
    preset: request.preset,
    products,
  });
  const date = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    body: `${BOM}${built.text}`,
    fileName: `attribute-values-${date}.csv`,
    rows: built.rows,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export type PreviewOutcome =
  | { ok: true; importId: string }
  | { ok: false; message: string };

/** Why a text is not a CSV a person made, or null. */
export function refuseFile(name: string, text: string): string | null {
  if (text.length === 0) return "The file is empty.";
  if (text.includes("\u0000") || text.startsWith("PK"))
    return "That is not a CSV file. In your spreadsheet, choose Save as and then CSV UTF-8, and upload that.";
  if (/^\s*[{[<]/.test(text))
    return "That is not a CSV file. Upload the CSV exported from this page, filled in.";
  if (text.includes("�"))
    return "The file is not saved as UTF-8, so letters such as č and š would be lost. Save it as CSV UTF-8 and upload it again.";
  if (/\.(xlsx?|ods|json|pdf|zip)$/i.test(name))
    return "That is not a CSV file. In your spreadsheet, choose Save as and then CSV UTF-8, and upload that.";
  return null;
}

export const TOO_LARGE = `The file is larger than ${LIMITS.fileBytes / 1024 / 1024} MB. Split it into parts of up to ${LIMITS.importRows.toLocaleString("en")} rows and upload them one after another.`;

export async function previewValues(
  admin: AdminApiContext,
  principal: Principal,
  file: { name: string; text: string; actor: string | null },
): Promise<PreviewOutcome> {
  if (Buffer.byteLength(file.text, "utf8") > LIMITS.fileBytes)
    return { ok: false, message: TOO_LARGE };
  const text = file.text.replace(/^﻿/, "");
  const refused = refuseFile(file.name, text);
  if (refused) return { ok: false, message: refused };

  const rows = parseCsvRows(text, { keepEmptyRows: true });
  if (rows.length - 1 > LIMITS.importRows * 2)
    return { ok: false, message: TOO_LARGE };
  const { schema } = await getAttributeSchema(principal);
  const { productIds, variantIds } = idsInRows(rows);
  const [products, definitions] = await Promise.all([
    loadValuesProducts(principal, { productIds, variantIds }),
    definitionTypes(admin),
  ]);
  const plan = planImport({ rows, schema, definitions, products });
  // Nothing is written to Shopify here; the stored preview is this app's own.
  const importId = await createImport(principal, {
    fileName: file.name || "values.csv",
    createdBy: file.actor,
    plan,
  });
  return { ok: true, importId };
}

/* -------------------------------------------------------------------------- */
/* Apply and discard                                                          */
/* -------------------------------------------------------------------------- */

const CLAIM_MESSAGE = {
  unknown: "That preview is not available. Upload the file again.",
  expired: "That preview has expired. Upload the file again to see it fresh.",
  busy: "Another import is being applied. Wait for it to finish.",
  already: "That import has been applied or is being applied.",
  nothing: "There is nothing to apply in that preview.",
} as const;

export type ApplyOutcome =
  | { ok: true }
  | { ok: false; message: string };

export async function applyValues(
  principal: Principal,
  importId: string,
  actor: string | null,
): Promise<ApplyOutcome> {
  const claim = await claimApply(principal, importId, actor);
  if (!claim.ok) return { ok: false, message: CLAIM_MESSAGE[claim.reason] };
  const shopDomain = shopDomainOf(principal);
  try {
    await enqueue(
      QUEUES.bulkValuesApply,
      { shopDomain, importId },
      { singletonKey: bulkValuesKey(importId) },
    );
  } catch (error) {
    getLogger().error({ err: error, shop: shopDomain }, "Bulk values not queued");
    // Claimed a moment ago: without the job it would stay queued.
    await finishRun(shopDomain, importId, {
      status: "failed",
      lastError: "The import could not be started. Try again in a moment.",
    });
    return {
      ok: false,
      message: "The import could not be started. Try again in a moment.",
    };
  }
  return { ok: true };
}

export async function discardValues(
  principal: Principal,
  importId: string,
): Promise<boolean> {
  return discardImport(principal, importId);
}

export { getImport };
