import { typeForProduct } from "~/domain/products/workspace";
import {
  KEYS,
  READINESS_MIN_COMPLETE,
  READINESS_ROLES,
  RIG_NAMESPACE,
  RIG_ROLES,
  ROLE_FIELDS,
  ROLE_TYPE_NAMES,
  type FieldSpec,
  type RigRole,
} from "~/domain/rig/keys";
import type { RigCandidate } from "~/domain/rig/types";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { MetafieldMap } from "~/domain/sales/types";

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

function readNumber(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function readCode(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  return text === "" ? null : text;
}

function lookup(
  key: string,
  product: RigSnapshotProduct,
  variant: RigSnapshotVariant,
): string | null {
  const name = `${RIG_NAMESPACE}.${key}`;
  return variant.metafields[name]?.value ?? product.metafields[name]?.value ?? null;
}

/** The role of a product: the plan's type for it, or one of its ancestors, names a role. */
export function roleOfProduct(
  plan: AttributeSchema,
  product: Pick<RigSnapshotProduct, "productType" | "categoryName" | "chosenTypeId">,
): "board" | "sail" | "mast" | "boom" | "base" | "fin" | null {
  const match = typeForProduct(plan, {
    categoryName: product.categoryName,
    categoryFullName: null,
    productType: product.productType,
    chosenTypeId: product.chosenTypeId,
  });
  if (match.kind !== "matched") return null;
  const names = match.path.map((name) => name.trim().toLowerCase());
  for (const role of ["board", "sail", "mast", "boom", "base", "fin"] as const) {
    if (names.includes(ROLE_TYPE_NAMES[role].toLowerCase())) return role;
  }
  return null;
}

function readField(
  spec: FieldSpec,
  product: RigSnapshotProduct,
  variant: RigSnapshotVariant,
): number | string | null {
  const raw = lookup(spec.key, product, variant);
  if (raw === null) return null;
  return spec.kind === "number" ? readNumber(raw) : readCode(raw);
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
    const baseRole = roleOfProduct(plan, product);
    if (!baseRole) continue;
    for (const variant of product.variants) {
      const id = numericId(variant.variantId);
      if (id === null) continue;
      // A base and an extension share a type; the extension has a length.
      const extensionLength =
        baseRole === "base"
          ? readNumber(lookup(KEYS.extensionLengthCm, product, variant) ?? "")
          : null;
      const role: RigRole =
        baseRole === "base" && extensionLength !== null && extensionLength > 0
          ? "extension"
          : baseRole;
      const fields = ROLE_FIELDS[role];
      const specs: RigCandidate["specs"] = {};
      const missing: string[] = [];
      for (const spec of fields.required) {
        const value = readField(spec, product, variant);
        if (value === null) missing.push(spec.key);
        else specs[spec.field] = value;
      }
      for (const spec of fields.optional) {
        const value = readField(spec, product, variant);
        if (value !== null) specs[spec.field] = value;
      }
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
        priceMinor: variant.priceMinor,
        currency: variant.currency,
        inStock:
          variant.availableForSale && (quantity === null || quantity > 0),
        inventoryQuantity: quantity,
        specs,
        missing,
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
  /** Products with at least one in-stock variant that has every attribute the engine reads. */
  complete: number;
  /** Required keys that active, in-stock variants lack, most common first. */
  missing: Array<{ key: string; count: number }>;
}

export interface RigReadiness {
  ready: boolean;
  roles: Record<RigRole, RoleReadiness>;
  /** The gating roles that have fewer complete products than needed. */
  notReady: RigRole[];
  minComplete: number;
}

/**
 * Whether the catalogue can feed the builder (PRD 4 US-406): each of board,
 * sail, mast, boom and fin needs at least three complete in-stock products.
 */
export function rigReadiness(
  plan: AttributeSchema,
  products: readonly RigSnapshotProduct[],
): RigReadiness {
  const roles = Object.fromEntries(
    RIG_ROLES.map((role) => [
      role,
      { products: 0, complete: 0, missing: [] as Array<{ key: string; count: number }> },
    ]),
  ) as Record<RigRole, RoleReadiness>;
  const missingCounts = new Map<RigRole, Map<string, number>>();

  for (const product of products) {
    if ((product.status ?? "").toUpperCase() !== "ACTIVE") continue;
    const candidates = candidatesFrom(plan, [product]);
    const seenProducts = new Set<RigRole>();
    const completeRoles = new Set<RigRole>();
    for (const candidate of candidates) {
      seenProducts.add(candidate.role);
      if (!candidate.inStock) continue;
      if (candidate.missing.length === 0) completeRoles.add(candidate.role);
      const counts = missingCounts.get(candidate.role) ?? new Map<string, number>();
      for (const key of candidate.missing) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      missingCounts.set(candidate.role, counts);
    }
    for (const role of seenProducts) roles[role].products += 1;
    for (const role of completeRoles) roles[role].complete += 1;
  }
  for (const role of RIG_ROLES) {
    roles[role].missing = [...(missingCounts.get(role) ?? [])]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }
  const notReady = READINESS_ROLES.filter(
    (role) => roles[role].complete < READINESS_MIN_COMPLETE,
  );
  return {
    ready: notReady.length === 0,
    roles,
    notReady: [...notReady],
    minComplete: READINESS_MIN_COMPLETE,
  };
}
