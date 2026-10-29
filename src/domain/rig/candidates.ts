import { typeForProduct } from "~/domain/products/workspace";
import {
  DISCIPLINE_TYPE_NAME,
  READINESS_MIN_COMPLETE,
  READINESS_ROLES,
  RIG_NAMESPACE,
  RIG_ROLES,
  ROLE_FIELDS,
  ROLE_TYPE_NAMES,
  placementGaps,
  type FieldSpec,
  type RigRole,
  type SpecField,
  type SpecValue,
  type Specs,
} from "~/domain/rig/keys";
import {
  carbonPercentFromTitle,
  finLengthFromText,
  mastDiameterFromTitle,
  mastLengthFromText,
  sailAreaFromText,
} from "~/domain/rig/derive";
import { readCode, readList, readNumber } from "~/domain/rig/values";
import type { RigCandidate } from "~/domain/rig/types";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { MetafieldMap, MetafieldValue } from "~/domain/sales/types";

/**
 * From the catalogue snapshot to the engine's candidates, and the readiness
 * line that says whether there are enough of them (docs/rig-builder.md §
 * Candidates and readiness). Pure: the adapter reads the rows and the plan,
 * this decides.
 */

export interface RigSnapshotVariant {
  /** Shopify variant GID. */
  variantId: string;
  title: string | null;
  /** Shopify's selectedOptions, e.g. `[{ name: "Size", value: "5.8 m2 / Orange" }]`. */
  options?: ReadonlyArray<{ name: string; value: string }>;
  priceMinor: number;
  currency: string;
  inventoryQuantity: number | null;
  availableForSale: boolean;
  metafields: MetafieldMap;
}

export interface RigSnapshotProduct {
  shopId: string;
  /** Shopify product GID. */
  productId: string;
  title: string;
  handle: string | null;
  status: string | null;
  productType: string | null;
  categoryName: string | null;
  /** The type a person chose for the product in the plan, if any. */
  chosenTypeId: string | null;
  imageUrl: string | null;
  vendor?: string | null;
  metafields: MetafieldMap;
  variants: RigSnapshotVariant[];
}

const GID_TAIL = /(\d+)$/;

/** The numeric id `/cart/add.js` takes, or null for something that is not a GID. */
export function numericId(gid: string): number | null {
  const match = GID_TAIL.exec(gid);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function entryOf(
  key: string,
  product: Pick<RigSnapshotProduct, "metafields">,
  variant: Pick<RigSnapshotVariant, "metafields">,
): MetafieldValue | undefined {
  const name = `${RIG_NAMESPACE}.${key}`;
  return variant.metafields[name] ?? product.metafields[name];
}

function readField(
  spec: FieldSpec,
  product: Pick<RigSnapshotProduct, "metafields">,
  variant: Pick<RigSnapshotVariant, "metafields">,
): SpecValue | null {
  const entry = entryOf(spec.key, product, variant);
  switch (spec.kind) {
    case "code":
      return readCode(entry);
    case "list":
      return readList(entry);
    case "number":
      return readNumber(entry);
    default:
      return readNumber(entry, spec.kind);
  }
}

/** The role and discipline of a product, from the plan's type for it and that type's ancestors. */
export interface Classified {
  role: RigRole;
  /** "freeride" for "Freeride sails"; null when the product sits on the role's own type. */
  category: string | null;
  /** The old pack's one type for bases and extensions. */
  combined: boolean;
}

export function classifyProduct(
  plan: AttributeSchema,
  product: Pick<RigSnapshotProduct, "productType" | "categoryName" | "chosenTypeId">,
): Classified | null {
  const match = typeForProduct(plan, {
    categoryName: product.categoryName,
    categoryFullName: null,
    productType: product.productType,
    chosenTypeId: product.chosenTypeId,
  });
  if (match.kind !== "matched") return null;
  const names = match.path.map((name) => name.trim().toLowerCase());
  if (!names.includes(DISCIPLINE_TYPE_NAME.toLowerCase())) return null;
  for (const role of RIG_ROLES) {
    const wanted = ROLE_TYPE_NAMES[role].map((name) => name.toLowerCase());
    const at = names.findIndex((name) => wanted.includes(name));
    if (at === -1) continue;
    const leaf = names[names.length - 1] ?? "";
    const category =
      at === names.length - 1 ? null : (leaf.split(/\s+/)[0] ?? null);
    return {
      role,
      category,
      combined: names[at] === "bases and extensions",
    };
  }
  return null;
}

/** The role of a product (kept for callers that only need that). */
export function roleOfProduct(
  plan: AttributeSchema,
  product: Pick<RigSnapshotProduct, "productType" | "categoryName" | "chosenTypeId">,
): RigRole | null {
  return classifyProduct(plan, product)?.role ?? null;
}

function derive(
  role: RigRole,
  product: Pick<RigSnapshotProduct, "title">,
  variant: RigSnapshotVariant,
  specs: Specs,
): SpecField[] {
  const derived: SpecField[] = [];
  const texts = [...(variant.options ?? []).map((o) => o.value), variant.title ?? ""]
    .map((text) => text.trim())
    .filter((text) => text !== "" && text.toLowerCase() !== "default title");
  const fill = (field: SpecField, value: SpecValue | null) => {
    if (specs[field] !== undefined || value === null) return;
    specs[field] = value;
    derived.push(field);
  };
  if (role === "sail") fill("areaM2", sailAreaFromText(texts));
  if (role === "mast") {
    fill("lengthCm", mastLengthFromText(texts));
    fill("mastDiameter", mastDiameterFromTitle(product.title));
    fill("carbonPercent", carbonPercentFromTitle(product.title));
  }
  if (role === "fin") fill("finLengthCm", finLengthFromText(texts));
  return derived;
}

/**
 * Every variant of the products the plan makes rig parts, as candidates.
 * A variant is kept even when it cannot be chosen (out of stock, attributes
 * missing) so the engine can count what it left out and why.
 */
export function candidatesFrom(
  plan: AttributeSchema,
  products: readonly RigSnapshotProduct[],
): RigCandidate[] {
  const out: RigCandidate[] = [];
  for (const product of products) {
    const classified = classifyProduct(plan, product);
    if (!classified) continue;
    for (const variant of product.variants) {
      const id = numericId(variant.variantId);
      if (id === null) continue;
      let role = classified.role;
      if (role === "base" && classified.combined) {
        const hasExtension = ROLE_FIELDS.extension.some(
          (spec) =>
            (spec.field === "extensionMinCm" || spec.field === "extensionMaxCm") &&
            readField(spec, product, variant) !== null,
        );
        if (hasExtension) role = "extension";
      }
      const specs: Specs = {};
      for (const spec of ROLE_FIELDS[role]) {
        const value = readField(spec, product, variant);
        if (value !== null) specs[spec.field] = value;
      }
      const derived = derive(role, product, variant, specs);
      const quantity = variant.inventoryQuantity;
      out.push({
        role,
        shopId: product.shopId,
        productId: product.productId,
        variantGid: variant.variantId,
        variantId: id,
        status: (product.status ?? "").toUpperCase(),
        title: product.title,
        variantTitle: variant.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
        vendor: product.vendor?.trim() || null,
        priceMinor: variant.priceMinor,
        currency: variant.currency,
        // Unknown stock (null) is not stock: the snapshot must be refreshed.
        inStock: variant.availableForSale && quantity !== null && quantity > 0,
        inventoryQuantity: quantity,
        specs,
        derived,
        category: role === "sail" || role === "board" ? classified.category : null,
        missing: placementGaps(role, specs),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

export interface RoleReadiness {
  /** Active products of this role. */
  products: number;
  /** Products with at least one variant that has what the rules need to place it (stock aside). */
  complete: number;
  /** Complete products that also have a variant in stock. */
  inStock: number;
  /** Active variants whose stock the snapshot does not know (inventory null). */
  stockUnknown: number;
  /** Active variants in all. */
  variants: number;
  /** Keys that active variants lack, most common first (counted in variants). */
  missing: Array<{ key: string; count: number }>;
  /** Active products with no complete variant, in catalogue order. */
  incomplete: string[];
  /** How many placed values were derived rather than stored, by field. */
  derived: Partial<Record<SpecField, number>>;
}

export interface RigReadiness {
  ready: boolean;
  roles: Record<RigRole, RoleReadiness>;
  /** The gating roles that have fewer complete in-stock products than needed. */
  notReady: RigRole[];
  minComplete: number;
  /** True when no active rig variant has a known stock level: refresh the catalogue. */
  stockNotRead: boolean;
}

/**
 * Whether the catalogue can feed the builder (PRD 4 US-406): each of board,
 * sail, mast, boom and fin needs at least three complete in-stock products.
 * "Complete" is data only; stock is counted beside it so a catalogue whose
 * stock was never read says that, instead of looking empty.
 */
export function readinessFromCandidates(
  candidates: readonly RigCandidate[],
): RigReadiness {
  const roles = Object.fromEntries(
    RIG_ROLES.map((role) => [
      role,
      {
        products: 0,
        complete: 0,
        inStock: 0,
        stockUnknown: 0,
        variants: 0,
        missing: [] as Array<{ key: string; count: number }>,
        incomplete: [] as string[],
        derived: {} as Partial<Record<SpecField, number>>,
      },
    ]),
  ) as Record<RigRole, RoleReadiness>;
  const missingCounts = new Map<RigRole, Map<string, number>>();
  interface Seen {
    role: RigRole;
    complete: boolean;
    inStock: boolean;
  }
  const products = new Map<string, Seen>();
  let known = 0;
  let active = 0;

  for (const candidate of candidates) {
    if (candidate.status !== "ACTIVE") continue;
    const role = roles[candidate.role];
    role.variants += 1;
    active += 1;
    if (candidate.inventoryQuantity === null) role.stockUnknown += 1;
    else known += 1;
    for (const field of candidate.derived) {
      role.derived[field] = (role.derived[field] ?? 0) + 1;
    }
    const counts =
      missingCounts.get(candidate.role) ?? new Map<string, number>();
    for (const key of candidate.missing) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    missingCounts.set(candidate.role, counts);

    const seen =
      products.get(candidate.productId) ??
      { role: candidate.role, complete: false, inStock: false };
    const complete = candidate.missing.length === 0;
    seen.complete ||= complete;
    seen.inStock ||= complete && candidate.inStock;
    products.set(candidate.productId, seen);
  }
  for (const [productId, seen] of products) {
    const role = roles[seen.role];
    role.products += 1;
    if (seen.complete) role.complete += 1;
    else role.incomplete.push(productId);
    if (seen.inStock) role.inStock += 1;
  }
  for (const role of RIG_ROLES) {
    roles[role].missing = [...(missingCounts.get(role) ?? [])]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }
  const notReady = READINESS_ROLES.filter(
    (role) => roles[role].inStock < READINESS_MIN_COMPLETE,
  );
  return {
    ready: notReady.length === 0,
    roles,
    notReady: [...notReady],
    minComplete: READINESS_MIN_COMPLETE,
    stockNotRead: active > 0 && known === 0,
  };
}

export function rigReadiness(
  plan: AttributeSchema,
  products: readonly RigSnapshotProduct[],
): RigReadiness {
  return readinessFromCandidates(candidatesFrom(plan, products));
}
