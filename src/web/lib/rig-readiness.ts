import type { AttributeSchema } from "~/domain/attributes/types";
import type { RigReadiness } from "~/domain/rig/candidates";
import { RIG_ROLES, roleWord, type RigRole } from "~/domain/rig/keys";

/**
 * Rig readiness in the merchant's words (docs/rig-builder.md, Readiness).
 * Client-safe: the Product setup pages read from here. One line per role,
 * counted on the keys the engine really reads (with the derivations), not on
 * what the plan marks as required.
 */

export interface ReadinessLine {
  /** The role plural, which is also the `?incomplete=` value. */
  type: string;
  name: string;
  products: number;
  /** Products with what the rules need to place them. */
  ready: number;
  /** The keys most variants lack, by name, most first (at most three). */
  missing: Array<{ name: string; count: number }>;
  /** Products still missing something; the link shows exactly these. */
  incomplete: number;
  href: string | null;
  /** No variant of this role has a known stock level yet. */
  stockNotRead: boolean;
}

export const incompleteProductsHref = (type: string) =>
  `/app/products?incomplete=${encodeURIComponent(type)}`;

/** The role behind an `?incomplete=` value, or null when it names none. */
export function roleOfType(type: string): RigRole | null {
  return RIG_ROLES.find((role) => roleWord(role) === type) ?? null;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function readinessLines(
  schema: AttributeSchema,
  readiness: RigReadiness,
): ReadinessLine[] {
  // The plan own name for a key, when it has one.
  const names = new Map(
    schema.attributes.map((a) => [a.key.replace(/^[^.]*\./, ""), a.name]),
  );
  return RIG_ROLES.flatMap((role) => {
    const row = readiness.roles[role];
    if (row.products === 0) return [];
    return [
      {
        type: roleWord(role),
        name: capitalise(roleWord(role)),
        products: row.products,
        ready: row.complete,
        missing: row.missing.slice(0, 3).map(({ key, count }) => ({
          name: names.get(key) ?? key,
          count,
        })),
        incomplete: row.incomplete.length,
        href:
          row.incomplete.length > 0
            ? incompleteProductsHref(roleWord(role))
            : null,
        stockNotRead: row.variants > 0 && row.stockUnknown === row.variants,
      },
    ];
  });
}

/** One line per role, each number stated once. */
export function readinessText(line: ReadinessLine): string {
  if (line.products === 0) return "No products";
  const stock = line.stockNotRead
    ? " · stock not read yet: refresh the catalogue"
    : "";
  if (line.incomplete === 0)
    return `All ${line.products} ${line.products === 1 ? "product has" : "products have"} the data the rig builder needs${stock}`;
  const missing = line.missing.map((m) => `${m.name} (${m.count})`).join(", ");
  return `${line.ready} of ${line.products} ready · missing ${missing}${stock}`;
}
