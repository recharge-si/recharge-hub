import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  assignedTypeFor,
  clearAssignedType,
} from "~/adapters/db/repositories/product-type-assignment.server";
import { liveHolds } from "~/adapters/db/repositories/product-workspace.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  applyAutofill,
  autofillAvailability,
  discardAutofill,
  requestAutofill,
} from "~/adapters/products/autofill.server";
import { chooseProductType } from "~/adapters/products/type-choice.server";
import { requestTypeMenuUpdate } from "~/adapters/products/type-menu-updates.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  readWorkspaceProduct,
  writeMetafields,
  writeProduct,
  writeVariants,
  type WorkspaceProduct,
} from "~/adapters/shopify/product-workspace";
import { isLocaleCode } from "~/adapters/shopify/translations";
import {
  saveTranslationEdits,
  translateForPerson,
} from "~/adapters/translations/edits.server";
import {
  assignableTypes,
  attributeChanges,
  namedWriteErrors,
  sameInput,
  type AttributeChanges,
  type AttributeField,
  type AttributeInputs,
} from "~/domain/products/attribute-values";
import {
  PRODUCT_STATUSES,
  cleanTags,
  productChanges,
  staleFields,
  typeForProduct,
  validateProduct,
  variantChanges,
  type ProductFieldErrors,
  type VariantFieldErrors,
  type VariantFields,
} from "~/domain/products/workspace";
import type { Principal } from "~/domain/types";
import { readAttributeValues } from "~/web/lib/product-attributes.server";
import { savedFields } from "~/web/lib/product-workspace.server";

/**
 * What the product workspace can do (docs/architecture.md § Product
 * workspace). Every write is a person pressing a button; nothing here runs
 * on a page load, and nothing here writes to MetaKocka.
 *
 * - `save`: the product's fields, its variants and the values the product
 *   setup plan asks for, in Shopify. Refused whole when a field is invalid,
 *   when something it would change was changed in Shopify after the page
 *   read it, or when it would change a price a live campaign holds.
 * - `choose-type`: which product type of the plan this product is, kept in
 *   this app; an empty type hands it back to the automatic match.
 * - `translate`: the engine, for this product, in the named languages.
 * - `save-translation`: a person's translations of this product.
 */

export type ProductActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: ProductFieldErrors;
      variantErrors?: Record<string, VariantFieldErrors>;
      /** By `inputKey`, for the product setup values. */
      attributeErrors?: Record<string, string>;
    };

const fieldsSchema = z.object({
  title: z.string(),
  descriptionHtml: z.string(),
  vendor: z.string(),
  productType: z.string(),
  status: z.enum(PRODUCT_STATUSES),
  tags: z.array(z.string()),
  seoTitle: z.string(),
  seoDescription: z.string(),
});

const saveSchema = z.object({
  pageRead: fieldsSchema,
  fields: fieldsSchema,
  variants: z
    .array(
      z.object({
        variantId: z.string().min(1),
        price: z.string(),
        compareAt: z.string(),
        sku: z.string(),
        barcode: z.string(),
        was: z
          .object({
            variantId: z.string(),
            priceMinor: z.number().int(),
            compareAtMinor: z.number().int().nullable(),
            sku: z.string().nullable(),
            barcode: z.string().nullable(),
          })
          .nullable(),
      }),
    )
    .max(250),
  attributes: z
    .object({
      typeId: z.string().min(1),
      pageRead: z.record(
        z.string(),
        z.union([z.string(), z.array(z.string())]),
      ),
      inputs: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    })
    .nullable()
    .optional(),
});

const translationSchema = z.object({
  locale: z.string(),
  fields: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string(),
        digest: z.string().min(1),
      }),
    )
    .min(1),
});

const UNREADABLE = "The form could not be read. Reload the page and try again.";

function parseJson(raw: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return undefined;
  }
}

const FIELD_WORDS: Record<string, string> = {
  title: "title",
  descriptionHtml: "description",
  vendor: "vendor",
  productType: "product type",
  status: "status",
  tags: "tags",
  seoTitle: "page title",
  seoDescription: "meta description",
  details: "product details",
  price: "price",
  compareAt: "compare-at price",
  sku: "SKU",
  barcode: "barcode",
};

function sameVariant(
  a: VariantFields,
  b: VariantFields,
  key: keyof VariantFields,
) {
  return a[key] === b[key];
}

/**
 * The Shopify client throws on a GraphQL-level error rather than returning
 * it, and an action that throws gives the page no answer at all: the save
 * bar stays up with nothing said. So whatever is thrown comes back as a
 * refusal with Shopify's own words, and is logged.
 */
export async function handleProductAction(input: {
  admin: AdminApiContext;
  principal: Principal;
  actor: string | null;
  productId: string;
  formData: FormData;
}): Promise<ProductActionResult> {
  try {
    return await runProductAction(input);
  } catch (error) {
    getLogger().error(
      { err: error, productId: input.productId },
      "Product workspace action failed",
    );
    return {
      ok: false,
      message: `The save stopped: ${thrownMessage(error)} Reload to see what was saved, then try again.`,
    };
  }
}

/** Shopify's GraphQL error messages when there are any, else the error's own. */
export function thrownMessage(error: unknown): string {
  const body =
    error && typeof error === "object" && "body" in error
      ? (error as { body?: unknown }).body
      : null;
  const errors =
    body && typeof body === "object" && "errors" in body
      ? (body as { errors?: unknown }).errors
      : null;
  const graphQLErrors =
    errors && typeof errors === "object" && "graphQLErrors" in errors
      ? (errors as { graphQLErrors?: unknown }).graphQLErrors
      : null;
  const messages = Array.isArray(graphQLErrors)
    ? graphQLErrors.flatMap((entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        "message" in entry &&
        typeof (entry as { message: unknown }).message === "string"
          ? [(entry as { message: string }).message]
          : [],
      )
    : [];
  const text =
    messages.length > 0
      ? messages.join("; ")
      : error instanceof Error
        ? error.message
        : "something went wrong";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

async function runProductAction(input: {
  admin: AdminApiContext;
  principal: Principal;
  actor: string | null;
  productId: string;
  formData: FormData;
}): Promise<ProductActionResult> {
  const { admin, principal, actor, productId, formData } = input;
  const intent = String(formData.get("intent") ?? "");

  // AI autofill (docs/attributes.md § AI autofill): ask, then apply what
  // a person kept, or discard it.
  if (intent === "autofill") {
    const available = await autofillAvailability(principal);
    if (!available.ok) return { ok: false, message: available.message };
    const queued = await requestAutofill(principal, [productId], actor);
    return {
      ok: true,
      message:
        queued > 0
          ? "Asking for suggestions. They appear here for review."
          : "Suggestions are already being made for this product.",
    };
  }
  if (intent === "apply-autofill")
    return applyAutofill(admin, principal, {
      productId,
      actor,
      keepType: formData.get("keepType") === "true",
      ...(String(formData.get("typeId") ?? "") !== ""
        ? { typeId: String(formData.get("typeId")) }
        : {}),
      keepValues: new Set(formData.getAll("keep").map(String)),
    });
  if (intent === "discard-autofill")
    return discardAutofill(principal, productId, actor);

  if (intent === "translate") {
    const locales = String(formData.get("locales") ?? "")
      .split(",")
      .map((locale) => locale.trim())
      .filter(Boolean);
    const mode = String(formData.get("mode") ?? "missing");
    if (locales.some((locale) => !isLocaleCode(locale)))
      return { ok: false, message: "Unknown language." };
    if (mode !== "missing" && mode !== "missing_outdated")
      return { ok: false, message: "Unknown action." };
    return translateForPerson(principal, admin, {
      resource: productId,
      type: "PRODUCT",
      locales,
      mode,
      actor,
    });
  }

  if (intent === "save-translation") {
    const parsed = translationSchema.safeParse(parseJson(formData.get("form")));
    if (!parsed.success || !isLocaleCode(parsed.data.locale))
      return { ok: false, message: UNREADABLE };
    // Only a language the store has, and never the one it is written in.
    const locales = await listShopLocales(admin);
    const target =
      locales.kind === "read"
        ? locales.locales.find(
            (l) => l.locale === parsed.data.locale && !l.primary,
          )
        : undefined;
    if (!target)
      return {
        ok: false,
        message: "That language is not one of the store’s translations.",
      };
    return saveTranslationEdits(principal, admin, {
      resource: productId,
      type: "PRODUCT",
      locale: target.locale,
      fields: parsed.data.fields,
      actor,
    });
  }

  if (intent === "choose-type") {
    const typeId = String(formData.get("typeId") ?? "");
    if (typeId === "") {
      await clearAssignedType(principal, productId);
      // Back to its matched type, or out of the menu: the next update says which.
      await requestTypeMenuUpdate(principal);
      await appendEvent(principal, {
        entityType: "product",
        entityId: productId,
        event: "product.type_chosen",
        detail: { type: null, by: actor },
      });
      return { ok: true, message: "Product type left to match automatically." };
    }
    const { schema } = await getAttributeSchema(principal);
    const type = assignableTypes(schema).find((t) => t.id === typeId);
    if (!type)
      return {
        ok: false,
        message:
          "That product type is no longer in the plan. Reload to see the current types.",
      };
    await chooseProductType(admin, principal, {
      schema,
      productId,
      typeId: type.id,
      chosenBy: actor,
    });
    await appendEvent(principal, {
      entityType: "product",
      entityId: productId,
      event: "product.type_chosen",
      detail: { typeId: type.id, type: type.path.join(" › "), by: actor },
    });
    return { ok: true, message: `Product type set to ${type.name}.` };
  }

  if (intent !== "save") return { ok: false, message: "Unknown action." };

  const parsed = saveSchema.safeParse(parseJson(formData.get("form")));
  if (!parsed.success) return { ok: false, message: UNREADABLE };
  const next = {
    ...parsed.data.fields,
    tags: cleanTags(parsed.data.fields.tags),
  };
  const pageRead = parsed.data.pageRead;

  const fieldErrors = validateProduct(next);

  // Variants: what changed against what the page read, and whether a
  // campaign holds any price it touches — asked of the database now, not
  // taken from the page.
  const was: VariantFields[] = parsed.data.variants.flatMap((row) =>
    row.was && row.was.variantId === row.variantId ? [row.was] : [],
  );
  const holds = await liveHolds(
    principal,
    parsed.data.variants.map((row) => row.variantId),
  );
  const variantResult = variantChanges(was, parsed.data.variants, holds);

  if (
    Object.keys(fieldErrors).length > 0 ||
    Object.keys(variantResult.errors).length > 0
  )
    return {
      ok: false,
      message: "Fix the fields marked below, then save again.",
      fieldErrors,
      variantErrors: variantResult.errors,
    };

  const { change, add, remove } = productChanges(pageRead, next);
  const productTouched =
    Object.keys(change).length > 0 || add.length > 0 || remove.length > 0;
  const attributes = parsed.data.attributes ?? null;
  const attributesTouched =
    attributes !== null &&
    Object.entries(attributes.inputs).some(
      ([key, input]) => !sameInput(attributes.pageRead[key], input),
    );
  if (
    !productTouched &&
    variantResult.changes.length === 0 &&
    !attributesTouched
  )
    return { ok: true, message: "Nothing to save." };

  // What Shopify holds now, so nothing someone else changed is overwritten.
  const live = await readWorkspaceProduct(admin, productId);
  if (!live)
    return { ok: false, message: "This product no longer exists in Shopify." };

  const attributePlan =
    attributes && attributesTouched
      ? await planAttributeSave(principal, admin, productId, live, attributes)
      : null;
  if (attributePlan && !attributePlan.ok) return attributePlan;
  const stale: string[] = staleFields(
    pageRead,
    savedFields(live),
    change,
    add.length > 0 || remove.length > 0,
  );
  const liveVariants = new Map(live.variants.map((v) => [v.variantId, v]));
  for (const variantChange of variantResult.changes) {
    const now = liveVariants.get(variantChange.variantId);
    const before = was.find((v) => v.variantId === variantChange.variantId);
    if (!now || !before) {
      stale.push("variants");
      continue;
    }
    const current: VariantFields = {
      variantId: now.variantId,
      priceMinor: now.priceMinor,
      compareAtMinor: now.compareAtMinor,
      sku: now.sku,
      barcode: now.barcode,
    };
    if (
      variantChange.priceMinor !== undefined &&
      !sameVariant(before, current, "priceMinor")
    )
      stale.push("price");
    if (
      variantChange.compareAtMinor !== undefined &&
      !sameVariant(before, current, "compareAtMinor")
    )
      stale.push("compareAt");
    if (variantChange.sku !== undefined && !sameVariant(before, current, "sku"))
      stale.push("sku");
    if (
      variantChange.barcode !== undefined &&
      !sameVariant(before, current, "barcode")
    )
      stale.push("barcode");
  }
  if (attributePlan?.stale) stale.push("details");
  if (stale.length > 0) {
    const words = [...new Set(stale.map((key) => FIELD_WORDS[key] ?? key))];
    return {
      ok: false,
      message: `The ${words.join(", ")} changed in Shopify after this page was opened. Reload to see the current values, then make your change again.`,
    };
  }

  const saved: string[] = [];
  if (productTouched) {
    const outcome = await writeProduct(admin, productId, change, {
      add,
      remove,
    });
    if (!outcome.ok) {
      const errors: ProductFieldErrors = {};
      for (const error of outcome.errors) {
        const key =
          error.field === "title" ||
          error.field === "vendor" ||
          error.field === "productType" ||
          error.field === "tags" ||
          error.field === "status"
            ? error.field
            : error.field === "descriptionHtml"
              ? "descriptionHtml"
              : null;
        if (key) errors[key] = error.message;
      }
      return {
        ok: false,
        message: `Shopify refused the change: ${outcome.errors.map((e) => e.message).join("; ")}`,
        fieldErrors: errors,
      };
    }
    const changedFields = [
      ...Object.keys(change),
      ...(add.length > 0 || remove.length > 0 ? ["tags"] : []),
    ];
    await appendEvent(principal, {
      entityType: "product",
      entityId: productId,
      event: "product.edited",
      detail: { fields: changedFields, by: actor },
    });
    saved.push("product");
  }

  if (variantResult.changes.length > 0) {
    const outcome = await writeVariants(
      admin,
      productId,
      variantResult.changes,
    );
    if (!outcome.ok)
      return {
        ok: false,
        message: `${saved.length > 0 ? "The product was saved, but " : ""}Shopify refused the variant changes: ${outcome.errors.map((e) => e.message).join("; ")}`,
      };
    await appendEvent(principal, {
      entityType: "product",
      entityId: productId,
      event: "product.variants_edited",
      detail: {
        variants: variantResult.changes.length,
        fields: [
          ...new Set(
            variantResult.changes.flatMap((c) =>
              Object.keys(c).filter((key) => key !== "variantId"),
            ),
          ),
        ],
        by: actor,
      },
    });
    saved.push(
      variantResult.changes.length === 1
        ? "1 variant"
        : `${variantResult.changes.length} variants`,
    );
  }

  if (
    attributePlan &&
    (attributePlan.writes.length > 0 || attributePlan.clears.length > 0)
  ) {
    const outcome = await writeMetafields(
      admin,
      attributePlan.writes,
      attributePlan.clears,
    );
    if (!outcome.ok)
      return {
        ok: false,
        message: `${saved.length > 0 ? `Saved the ${saved.join(" and ")}, but ` : ""}Shopify refused the product details: ${namedWriteErrors(outcome.errors, attributePlan.writes, attributePlan.fields).join("; ")}`,
      };
    const count = attributePlan.writes.length + attributePlan.clears.length;
    await appendEvent(principal, {
      entityType: "product",
      entityId: productId,
      event: "product.details_edited",
      detail: { values: count, by: actor },
    });
    saved.push(count === 1 ? "1 detail" : `${count} details`);
  }

  return { ok: true, message: `Saved ${saved.join(" and ")}.` };
}

/**
 * The metafield writes for a save of product setup values, checked against
 * what Shopify and the plan hold now: the product must still be the type
 * the page showed, every entry must be valid, and a value someone else
 * changed after the page read it makes the save stale.
 */
async function planAttributeSave(
  principal: Principal,
  admin: AdminApiContext,
  productId: string,
  live: WorkspaceProduct,
  attributes: {
    typeId: string;
    pageRead: AttributeInputs;
    inputs: AttributeInputs;
  },
): Promise<
  | ({ ok: true; stale: boolean; fields: AttributeField[] } & Pick<
      AttributeChanges,
      "writes" | "clears"
    >)
  | Extract<ProductActionResult, { ok: false }>
> {
  const [{ schema }, chosenTypeId] = await Promise.all([
    getAttributeSchema(principal),
    assignedTypeFor(principal, productId),
  ]);
  const match = typeForProduct(schema, {
    categoryName: live.category?.name ?? null,
    categoryFullName: live.category?.fullName ?? null,
    productType: live.productType,
    chosenTypeId,
  });
  if (match.kind !== "matched" || match.typeId !== attributes.typeId)
    return {
      ok: false,
      message:
        "This product’s type in the plan changed after the page was opened. Reload to see its details, then enter them again.",
    };

  const now = await readAttributeValues(admin, schema, match.typeId, live);
  const planned = attributeChanges(
    now.fields,
    {
      productId,
      variantIds: live.variants.map((variant) => variant.variantId),
    },
    attributes.pageRead,
    attributes.inputs,
  );
  if (Object.keys(planned.errors).length > 0)
    return {
      ok: false,
      message: "Fix the fields marked below, then save again.",
      attributeErrors: planned.errors,
    };
  return {
    ok: true,
    stale: planned.changed.some(
      (key) => !sameInput(attributes.pageRead[key], now.inputs[key]),
    ),
    writes: planned.writes,
    clears: planned.clears,
    fields: now.fields,
  };
}
