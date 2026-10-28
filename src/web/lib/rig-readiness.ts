import type { RigCoverage } from "~/domain/attributes/coverage";
import type { AttributeSchema } from "~/domain/attributes/types";

/**
 * Rig readiness in the merchant's words (docs/attributes.md, Rig
 * readiness). Client-safe: the Product setup pages read from here.
 */

export interface ReadinessLine {
  type: string;
  name: string;
  products: number;
  ready: number;
  /** The attributes most products lack, by name, most first (at most three). */
  missing: Array<{ name: string; count: number }>;
  /** Products still missing something; the link shows exactly these. */
  incomplete: number;
  href: string | null;
}

export const incompleteProductsHref = (type: string) =>
  `/app/products?incomplete=${encodeURIComponent(type)}`;

export function readinessLines(
  schema: AttributeSchema,
  coverage: readonly RigCoverage[],
): ReadinessLine[] {
  const names = new Map(
    schema.attributes.map((a) => [a.key.replace(/^[^.]*\./, ""), a.name]),
  );
  return coverage.map((c) => ({
    type: c.type,
    name: c.name,
    products: c.products,
    ready: c.withAllRequired,
    missing: Object.entries(c.missing)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([key, count]) => ({ name: names.get(key) ?? key, count })),
    incomplete: c.incomplete.length,
    href: c.incomplete.length > 0 ? incompleteProductsHref(c.type) : null,
  }));
}

/** One line per type, each number stated once. */
export function readinessText(line: ReadinessLine): string {
  if (line.products === 0) return "No products";
  if (line.incomplete === 0)
    return `All ${line.products} ${line.products === 1 ? "product has" : "products have"} the data the rig builder needs`;
  const missing = line.missing.map((m) => `${m.name} (${m.count})`).join(", ");
  return `${line.ready} of ${line.products} ready · missing ${missing}`;
}
