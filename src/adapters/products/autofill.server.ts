import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  countUnaskedProducts,
  decideAutofill,
  failAutofill,
  getAutofill,
  markAutofillRunning,
  queueAutofills,
  saveAutofillSuggestion,
} from "~/adapters/db/repositories/product-autofill.server";
import { assignmentsFor } from "~/adapters/db/repositories/product-type-assignment.server";
import {
  ExportPortalError,
  describeForMerchant,
} from "~/adapters/export-portal/errors";
import { portalFor } from "~/adapters/export-portal/service.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { readAttributeValues } from "~/adapters/products/attribute-values.server";
import { enqueue } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { chooseProductType } from "~/adapters/products/type-choice.server";
import {
  readWorkspaceProduct,
  writeMetafields,
  type WorkspaceProduct,
} from "~/adapters/shopify/product-workspace";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { AiProduct } from "~/domain/export-portal/contract";
import {
  assignableTypes,
  attributeChanges,
} from "~/domain/products/attribute-values";
import {
  attributesToFill,
  chosenType,
  confidentEnough,
  inputsWithSuggestions,
  plainText,
  suggestedValues,
} from "~/domain/products/autofill";
import { typeForProduct } from "~/domain/products/workspace";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * AI autofill (docs/attributes.md § AI autofill): asking the export
 * portal's categorizer for a product's type and attribute values, holding
 * what it says for review, and applying what a person keeps.
 *
 * Suggesting writes nothing to Shopify and chooses nothing: the suggestion
 * is a row in `product_autofill`. Applying goes through the same two paths
 * a person's own edits do — `chooseProductType` and the attribute save's
 * `attributeChanges` — so an applied suggestion is indistinguishable from
 * a hand-made one, except in the event log.
 */

export const AUTOFILL_ENGINE = "export-portal";

/** What to suggest: the type always, the type's attribute values unless told not to. */
export interface AutofillOptions {
  fillAttributes: boolean;
  /**
   * Apply a confident suggestion at once (`confidentEnough`) instead of
   * leaving it for review: a source set to. What is not confident waits.
   */
  autoApply?: boolean;
  /** Who asked, recorded as who applied an automatic suggestion. */
  requestedBy?: string | null;
}

/** The model takes seconds per call; a job waits, a page does not. */
const AI_TIMEOUT_MS = 90_000;
/** Products per categorize call: well inside the portal's 100 kB request limit. */
const CATEGORIZE_BATCH = 10;
/**
 * What the portal accepts in one request (its `LIMITS` in
 * `productAutofill.service.js`, a 422 beyond them). Checked here first so a
 * large plan gets one clear sentence per product, not a refusal per batch.
 */
export const PORTAL_MAX_CATEGORIES = 2000;
export const PORTAL_MAX_ATTRIBUTES = 200;
/** Shorter in a batch, where the name and supplier data decide the type. */
const CATEGORIZE_DESCRIPTION = 1200;

function aiProduct(product: WorkspaceProduct, descriptionLimit?: number): AiProduct {
  return {
    code: product.productId,
    shopifyProductId: product.productId,
    name: product.title,
    vendor: product.vendor || undefined,
    productType: product.productType || undefined,
    category: product.category?.fullName || undefined,
    tags: product.tags.slice(0, 40),
    description:
      plainText(product.descriptionHtml, descriptionLimit) || undefined,
    options: product.hasOnlyDefaultVariant ? [] : product.options,
    variants: product.hasOnlyDefaultVariant
      ? []
      : product.variants.map((variant) => ({
          id: variant.variantId,
          title: variant.title,
          ...(variant.sku ? { sku: variant.sku } : {}),
          options: variant.options,
        })),
  };
}

/** A portal refusal in words a merchant can act on; the AI's own words for an AI failure. */
function failureText(error: unknown): string {
  if (error instanceof ExportPortalError) {
    if (error.httpStatus === 502 || error.httpStatus === 503) return error.message;
    return describeForMerchant(error);
  }
  return "Something went wrong while asking for suggestions. Try again.";
}

/** The type a product has now: chosen by a person, else matched as the product page matches it. */
function currentType(
  schema: AttributeSchema,
  product: WorkspaceProduct,
  chosenTypeId: string | null,
): string | null {
  const match = typeForProduct(schema, {
    categoryName: product.category?.name ?? null,
    categoryFullName: product.category?.fullName ?? null,
    productType: product.productType || null,
    chosenTypeId,
  });
  return match.kind === "matched" ? match.typeId : null;
}

/**
 * Suggestions for these products, each saved as it is made. A product that
 * already has a type keeps it and only its empty attributes are asked for;
 * the others are categorized in batches first. A failure is recorded on the
 * product it concerns; a failure that concerns them all (no connection, a
 * refused key) is recorded on every one.
 */
export async function suggestAutofill(
  admin: AdminApiContext,
  principal: Principal,
  productIds: readonly string[],
  options: AutofillOptions = { fillAttributes: true },
): Promise<void> {
  const log = getLogger();
  const failAll = async (ids: readonly string[], message: string) => {
    for (const id of ids) await failAutofill(principal, id, message);
  };

  const portal = await portalFor(principal, { timeoutMs: AI_TIMEOUT_MS });
  if (!portal.ok) {
    await failAll(productIds, portal.message);
    return;
  }
  const { schema } = await getAttributeSchema(principal);
  const types = assignableTypes(schema);
  if (types.length === 0) {
    await failAll(
      productIds,
      "There are no product types to choose from. Add product types under Metafields first.",
    );
    return;
  }

  const chosen = await assignmentsFor(principal, productIds);
  const products: WorkspaceProduct[] = [];
  for (const id of productIds) {
    await markAutofillRunning(principal, id);
    const product = await readWorkspaceProduct(admin, id).catch(
      (error: unknown) => {
        log.warn({ err: error, productId: id }, "Autofill could not read product");
        return null;
      },
    );
    if (product) products.push(product);
    else
      await failAutofill(
        principal,
        id,
        "The product could not be read from Shopify. It may have been deleted.",
      );
  }

  // Which products need a type; the rest keep the one they have.
  const kept = new Map<string, string>();
  const toCategorize: WorkspaceProduct[] = [];
  for (const product of products) {
    const typeId = currentType(
      schema,
      product,
      chosen.get(product.productId)?.typeId ?? null,
    );
    if (typeId) kept.set(product.productId, typeId);
    else toCategorize.push(product);
  }

  if (toCategorize.length > 0 && types.length > PORTAL_MAX_CATEGORIES) {
    await failAll(
      toCategorize.map((p) => p.productId),
      `The product type list has ${types.length} entries; the AI can read at most ${PORTAL_MAX_CATEGORIES}.`,
    );
    toCategorize.length = 0;
  }

  const suggested = new Map<
    string,
    { typeId: string | null; confidence: number | null; reason: string | null }
  >();
  const categories = types.map((type) => ({
    id: type.id,
    label: type.path.join(" > "),
  }));
  for (let start = 0; start < toCategorize.length; start += CATEGORIZE_BATCH) {
    const batch = toCategorize.slice(start, start + CATEGORIZE_BATCH);
    try {
      const results = await portal.client.categorize({
        products: batch.map((p) => aiProduct(p, CATEGORIZE_DESCRIPTION)),
        categories,
      });
      for (const result of results) {
        const type = chosenType(result.categoryId, types);
        suggested.set(result.code, {
          typeId: type?.id ?? null,
          confidence: type ? result.confidence : null,
          reason: result.reason,
        });
      }
    } catch (error) {
      log.warn({ err: error }, "Autofill categorize failed");
      for (const product of batch)
        await failAutofill(principal, product.productId, failureText(error));
    }
  }

  for (const product of products) {
    const keptType = kept.get(product.productId) ?? null;
    const guess = suggested.get(product.productId);
    if (!keptType && !guess) continue; // its batch failed and was recorded
    const typeId = keptType ?? guess?.typeId ?? null;

    try {
      let values: Awaited<ReturnType<typeof suggestedValues>> = [];
      if (typeId && options.fillAttributes) {
        const read = await readAttributeValues(admin, schema, typeId, product);
        const variantIds = product.variants.map((v) => v.variantId);
        const ask = attributesToFill(read.fields, read.inputs, variantIds);
        if (ask.length > PORTAL_MAX_ATTRIBUTES) {
          await failAutofill(
            principal,
            product.productId,
            `This product has ${ask.length} attributes to fill; the AI can read at most ${PORTAL_MAX_ATTRIBUTES}.`,
          );
          continue;
        }
        if (ask.length > 0) {
          const answer = await portal.client.extractAttributes({
            product: aiProduct(product),
            attributes: ask.map((attribute) => ({
              id: attribute.id,
              name: attribute.name,
              ...(attribute.description
                ? { description: attribute.description }
                : {}),
              format: attribute.format,
              ...(attribute.unit ? { unit: attribute.unit } : {}),
              ...(attribute.options.length > 0
                ? { options: attribute.options }
                : {}),
              level: attribute.level,
            })),
          });
          values = suggestedValues(read.fields, read.inputs, variantIds, {
            values: answer,
          });
        }
      }
      const suggestion = {
        typeId,
        typeOrigin: keptType ? ("kept" as const) : ("suggested" as const),
        typeConfidence: keptType ? null : (guess?.confidence ?? null),
        typeReason: keptType ? null : (guess?.reason ?? null),
        values,
        engine: AUTOFILL_ENGINE,
      };
      await saveAutofillSuggestion(principal, product.productId, suggestion);
      if (options.autoApply && confidentEnough(suggestion))
        await applyAutomatically(
          admin,
          principal,
          product.productId,
          options.requestedBy ?? null,
        );
    } catch (error) {
      log.warn(
        { err: error, productId: product.productId },
        "Autofill attribute suggestion failed",
      );
      await failAutofill(principal, product.productId, failureText(error));
    }
  }
}

/**
 * A confident suggestion applied as a person's press of Apply would apply
 * it: the type, then every suggested value still empty. When Shopify
 * refuses, the suggestion stays waiting on Review rather than failing, since
 * it is still a good suggestion.
 */
async function applyAutomatically(
  admin: AdminApiContext,
  principal: Principal,
  productId: string,
  actor: string | null,
): Promise<void> {
  try {
    const outcome = await applyAutofill(admin, principal, {
      productId,
      actor,
      keepType: true,
      keepValues: null,
      automatic: true,
    });
    if (!outcome.ok)
      getLogger().warn(
        { productId, message: outcome.message },
        "Autofill not applied automatically; left for review",
      );
  } catch (error) {
    getLogger().warn(
      { err: error, productId },
      "Autofill not applied automatically; left for review",
    );
  }
}

export type ApplyOutcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * Applies what a person kept of a suggestion: the type, if it was
 * suggested and kept and is still in the plan, then the kept values that
 * are still empty. Values are for the type they were suggested for; if the
 * product has another type by now, they are not written.
 */
export async function applyAutofill(
  admin: AdminApiContext,
  principal: Principal,
  input: {
    productId: string;
    actor: string | null;
    keepType: boolean;
    /**
     * A type the person chose instead of the suggestion; it wins over
     * `keepType`. Values were read for the suggested type, so with another
     * type they are not written.
     */
    typeId?: string;
    /** Input keys of the values to apply; null keeps them all. */
    keepValues: ReadonlySet<string> | null;
    /** Applied by a source's setting, not by a person's press. */
    automatic?: boolean;
  },
): Promise<ApplyOutcome> {
  const { productId, actor } = input;
  const state = await getAutofill(principal, productId);
  if (!state || state.status !== "ready")
    return {
      ok: false,
      message: "There is no suggestion waiting for this product. Reload to see where it stands.",
    };
  const { schema } = await getAttributeSchema(principal);
  const product = await readWorkspaceProduct(admin, productId);
  if (!product)
    return { ok: false, message: "The product could not be read from Shopify." };

  let typeApplied = false;
  const chosenTypeId =
    input.typeId ??
    (input.keepType && state.typeOrigin === "suggested" ? state.typeId : null);
  if (
    chosenTypeId &&
    assignableTypes(schema).some((type) => type.id === chosenTypeId)
  ) {
    await chooseProductType(admin, principal, {
      schema,
      productId,
      typeId: chosenTypeId,
      chosenBy: actor,
    });
    typeApplied = true;
  }

  const chosen = (await assignmentsFor(principal, [productId])).get(productId);
  const typeNow = currentType(schema, product, chosen?.typeId ?? null);

  let written = 0;
  const wanted = state.values.filter(
    (value) => input.keepValues === null || input.keepValues.has(value.key),
  );
  if (wanted.length > 0 && typeNow !== null && typeNow === state.typeId) {
    const read = await readAttributeValues(admin, schema, typeNow, product);
    const after = inputsWithSuggestions(read.inputs, wanted, null);
    const changes = attributeChanges(
      read.fields,
      {
        productId,
        variantIds: product.variants.map((variant) => variant.variantId),
      },
      read.inputs,
      after,
    );
    if (changes.writes.length > 0) {
      const outcome = await writeMetafields(admin, changes.writes, []);
      if (!outcome.ok)
        return {
          ok: false,
          message: `Shopify refused the values: ${outcome.errors.map((e) => e.message).join("; ")}`,
        };
    }
    written = changes.writes.length;
  }

  await decideAutofill(principal, productId, "applied", actor);
  await appendEvent(principal, {
    entityType: "product",
    entityId: productId,
    event: "product.autofill_applied",
    detail: {
      by: actor,
      typeId: typeApplied ? chosenTypeId : null,
      typeOverridden: typeApplied && chosenTypeId !== state.typeId,
      values: written,
      engine: state.engine,
      ...(input.automatic ? { automatic: true } : {}),
    },
  });

  const parts = [
    typeApplied ? "type set" : null,
    written > 0 ? `${written} value${written === 1 ? "" : "s"} filled` : null,
  ].filter(Boolean);
  const skippedValues =
    wanted.length > 0 && typeNow !== state.typeId
      ? " The values were for another product type, so none were written."
      : "";
  return {
    ok: true,
    message:
      (parts.length > 0 ? `Applied: ${parts.join(", ")}.` : "Nothing left to apply.") +
      skippedValues,
  };
}

export async function discardAutofill(
  principal: Principal,
  productId: string,
  actor: string | null,
): Promise<ApplyOutcome> {
  const closed = await decideAutofill(principal, productId, "discarded", actor);
  return closed
    ? { ok: true, message: "Suggestion discarded." }
    : {
        ok: false,
        message: "There is no suggestion waiting for this product. Reload to see where it stands.",
      };
}

/**
 * Asks about every catalogue product the AI has not been asked about yet,
 * a pass of ten at a time (the job walks the catalogue). Returns how many
 * that is now; zero queues nothing.
 */
export async function requestAutofillAll(
  principal: Principal,
  requestedBy: string | null,
  options: AutofillOptions,
): Promise<number> {
  const count = await countUnaskedProducts(principal);
  if (count === 0) return 0;
  await enqueue(QUEUES.productAutofill, {
    shopDomain: shopDomainOf(principal),
    all: { after: null },
    fillAttributes: options.fillAttributes,
    autoApply: options.autoApply ?? false,
    requestedBy,
  });
  return count;
}

/**
 * Applies suggestions in the background, as a press of Apply would, ten a
 * pass: these products (a selection too large to apply while the page
 * waits), or, with null, every suggestion waiting.
 */
export async function requestApplyAutofill(
  principal: Principal,
  actor: string | null,
  productIds: readonly string[] | null,
): Promise<void> {
  await enqueue(QUEUES.productAutofill, {
    shopDomain: shopDomainOf(principal),
    apply: {
      ids: productIds ? productIds.slice(0, AUTOFILL_REQUEST_LIMIT) : null,
      after: null,
    },
    requestedBy: actor,
  });
}

/** At most this many products per request; the job works through them ten at a time. */
export const AUTOFILL_REQUEST_LIMIT = 250;

/** Whether suggestions can be asked for at all, and if not, why — without calling anyone. */
export async function autofillAvailability(
  principal: Principal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const portal = await portalFor(principal);
  return portal.ok ? { ok: true } : { ok: false, message: portal.message };
}

/**
 * Asks for suggestions: the products are marked queued at once (so every
 * page shows it) and handed to the job. Products already queued or being
 * worked on are not asked twice. Returns how many were queued.
 */
export async function requestAutofill(
  principal: Principal,
  productIds: readonly string[],
  requestedBy: string | null,
  options: AutofillOptions = { fillAttributes: true },
): Promise<number> {
  const queued = await queueAutofills(
    principal,
    productIds.slice(0, AUTOFILL_REQUEST_LIMIT),
    requestedBy,
  );
  if (queued.length > 0) {
    try {
      await enqueue(QUEUES.productAutofill, {
        shopDomain: shopDomainOf(principal),
        productIds: queued,
        fillAttributes: options.fillAttributes,
        autoApply: options.autoApply ?? false,
        requestedBy,
      });
    } catch (error) {
      // Marked queued a moment ago: without the job they would stay so.
      for (const id of queued)
        await failAutofill(
          principal,
          id,
          "Suggestions could not be asked for just now. Try again.",
        );
      throw error;
    }
  }
  return queued.length;
}
