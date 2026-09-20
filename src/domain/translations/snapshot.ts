import { compareCodepoints } from "~/domain/types";
import { clip, normaliseTerm, stripHtml } from "~/domain/translations/text";

/**
 * What the store looks like, read once and sampled deterministically
 * (docs/translations.md § Store profile). The snapshot is the bounded read
 * an adapter makes — titles, labels, vendors, types, tags, option names —
 * and never the whole catalogue, never a customer, never an order. The
 * sample is the smaller, representative slice of it that the model is
 * shown to infer what kind of store this is.
 *
 * Pure. The same snapshot always yields the same sample, so a profile can
 * be compared against a fresh read to decide whether the store has changed
 * enough to be worth reading again.
 */

export interface SnapshotMenuItem {
  id: string;
  title: string;
  /** Shopify's `MenuItemType`: COLLECTION, PRODUCT, PAGE, HTTP, … */
  type: string | null;
  resourceId: string | null;
  items: SnapshotMenuItem[];
}

export interface SnapshotMenu {
  id: string;
  handle: string;
  title: string;
  items: SnapshotMenuItem[];
}

export interface SnapshotCollection {
  id: string;
  title: string;
  description: string | null;
  productsCount: number | null;
}

export interface SnapshotProduct {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  options: Array<{ name: string; values: string[] }>;
}

export interface StoreSnapshot {
  shopName: string | null;
  shopDescription: string | null;
  primaryLocale: string;
  menus: SnapshotMenu[];
  collections: SnapshotCollection[];
  /** A bounded page of products; `productsTotal` says how many there are. */
  products: SnapshotProduct[];
  productsTotal: number | null;
  blogs: Array<{ id: string; title: string }>;
}

export interface Counted {
  value: string;
  count: number;
}

export interface StoreSample {
  shopName: string | null;
  shopDescription: string | null;
  primaryLocale: string;
  menus: Array<{ title: string; labels: string[] }>;
  collections: Array<{ title: string; description: string | null; productsCount: number | null }>;
  vendors: Counted[];
  productTypes: Counted[];
  tags: Counted[];
  optionNames: Array<{ name: string; values: string[] }>;
  productTitles: string[];
  blogs: string[];
  totals: { products: number; collections: number; menuItems: number };
}

/** Limits that keep the sample a page or two of text, whatever the store's size. */
export const SAMPLE_LIMITS = {
  menuLabels: 120,
  collections: 60,
  describedCollections: 20,
  vendors: 40,
  productTypes: 40,
  tags: 60,
  optionNames: 12,
  optionValues: 6,
  productTitles: 120,
  blogs: 10,
  descriptionChars: 600,
  collectionDescriptionChars: 140,
} as const;

/** Every label of a menu, depth first, with its depth for indentation. */
export function flattenMenu(items: readonly SnapshotMenuItem[], depth = 0): Array<{ title: string; depth: number }> {
  const out: Array<{ title: string; depth: number }> = [];
  for (const item of items) {
    if (item.title.trim() !== "") out.push({ title: item.title.trim(), depth });
    out.push(...flattenMenu(item.items, depth + 1));
  }
  return out;
}

export function countValues(values: Iterable<string>): Counted[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    const key = normaliseTerm(value);
    if (key === "") continue;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].sort(byCountThenValue);
}

function byCountThenValue(a: Counted, b: Counted): number {
  return b.count - a.count || compareCodepoints(a.value, b.value);
}

/**
 * Product titles chosen to represent the range rather than the top of the
 * list: round-robin across product types (largest first), titles in
 * codepoint order within each, so a store with one huge type and nine
 * small ones shows all ten.
 */
export function representativeTitles(products: readonly SnapshotProduct[], limit: number): string[] {
  const groups = new Map<string, string[]>();
  for (const product of products) {
    const title = product.title.trim();
    if (title === "") continue;
    const key = normaliseTerm(product.productType ?? "") || "\u0000";
    groups.set(key, [...(groups.get(key) ?? []), title]);
  }
  const ordered = [...groups.entries()]
    .map(([key, titles]) => ({ key, titles: [...new Set(titles)].sort(compareCodepoints) }))
    .sort((a, b) => b.titles.length - a.titles.length || compareCodepoints(a.key, b.key));
  const picked: string[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < limit; round += 1) {
    let any = false;
    for (const group of ordered) {
      const title = group.titles[round];
      if (title === undefined) continue;
      any = true;
      if (seen.has(title)) continue;
      seen.add(title);
      picked.push(title);
      if (picked.length >= limit) break;
    }
    if (!any) break;
  }
  return picked;
}

export function buildStoreSample(snapshot: StoreSnapshot): StoreSample {
  const menuItems = snapshot.menus.flatMap((menu) => flattenMenu(menu.items));
  const optionCounts = new Map<string, { name: string; values: Map<string, number>; count: number }>();
  for (const product of snapshot.products) {
    for (const option of product.options) {
      const key = normaliseTerm(option.name);
      if (key === "") continue;
      const entry = optionCounts.get(key) ?? { name: option.name.trim(), values: new Map(), count: 0 };
      entry.count += 1;
      for (const value of option.values) {
        const v = value.trim();
        if (v !== "") entry.values.set(v, (entry.values.get(v) ?? 0) + 1);
      }
      optionCounts.set(key, entry);
    }
  }

  const collections = [...snapshot.collections]
    .filter((c) => c.title.trim() !== "")
    .sort(
      (a, b) =>
        (b.productsCount ?? 0) - (a.productsCount ?? 0) || compareCodepoints(a.title, b.title),
    )
    .slice(0, SAMPLE_LIMITS.collections);

  return {
    shopName: snapshot.shopName,
    shopDescription: snapshot.shopDescription
      ? clip(stripHtml(snapshot.shopDescription), SAMPLE_LIMITS.descriptionChars)
      : null,
    primaryLocale: snapshot.primaryLocale,
    menus: snapshot.menus
      .map((menu) => ({
        title: menu.title,
        labels: flattenMenu(menu.items).map((item) => `${"  ".repeat(item.depth)}${item.title}`),
      }))
      .filter((menu) => menu.labels.length > 0)
      .map((menu, index, all) => {
        // The label budget is shared across menus, first come first served
        // in Shopify's order; the main menu is first there.
        const before = all.slice(0, index).reduce((sum, m) => sum + m.labels.length, 0);
        const room = Math.max(0, SAMPLE_LIMITS.menuLabels - before);
        return { title: menu.title, labels: menu.labels.slice(0, room) };
      })
      .filter((menu) => menu.labels.length > 0),
    collections: collections.map((collection, index) => ({
      title: collection.title.trim(),
      description:
        index < SAMPLE_LIMITS.describedCollections && collection.description
          ? clip(stripHtml(collection.description), SAMPLE_LIMITS.collectionDescriptionChars) || null
          : null,
      productsCount: collection.productsCount,
    })),
    vendors: countValues(snapshot.products.map((p) => p.vendor ?? "")).slice(0, SAMPLE_LIMITS.vendors),
    productTypes: countValues(snapshot.products.map((p) => p.productType ?? "")).slice(
      0,
      SAMPLE_LIMITS.productTypes,
    ),
    tags: countValues(snapshot.products.flatMap((p) => p.tags))
      .filter((tag) => tag.count >= 2)
      .slice(0, SAMPLE_LIMITS.tags),
    optionNames: [...optionCounts.values()]
      .sort((a, b) => b.count - a.count || compareCodepoints(a.name, b.name))
      .slice(0, SAMPLE_LIMITS.optionNames)
      .map((option) => ({
        name: option.name,
        values: [...option.values.entries()]
          .sort((a, b) => b[1] - a[1] || compareCodepoints(a[0], b[0]))
          .slice(0, SAMPLE_LIMITS.optionValues)
          .map(([value]) => value),
      })),
    productTitles: representativeTitles(snapshot.products, SAMPLE_LIMITS.productTitles),
    blogs: snapshot.blogs
      .map((blog) => blog.title.trim())
      .filter((title) => title !== "")
      .slice(0, SAMPLE_LIMITS.blogs),
    totals: {
      products: snapshot.productsTotal ?? snapshot.products.length,
      collections: snapshot.collections.length,
      menuItems: menuItems.length,
    },
  };
}

/**
 * The vocabulary a profile was built from, as a sorted set, so two reads of
 * the store can be compared: the share of terms they have in common says
 * whether the store has changed enough for the profile to be stale.
 */
export function sampleVocabulary(sample: StoreSample): string[] {
  const terms = new Set<string>();
  const add = (value: string) => {
    const key = normaliseTerm(value);
    if (key !== "") terms.add(key);
  };
  for (const menu of sample.menus) menu.labels.forEach(add);
  for (const collection of sample.collections) add(collection.title);
  for (const vendor of sample.vendors) add(vendor.value);
  for (const type of sample.productTypes) add(type.value);
  for (const tag of sample.tags) add(tag.value);
  return [...terms].sort(compareCodepoints);
}

/** Jaccard similarity of two vocabularies: 1 when identical, 0 when disjoint. */
export function vocabularyOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const term of setA) if (setB.has(term)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** The sample as the profile model reads it: compact, labelled, nothing else. */
export function renderStoreSample(sample: StoreSample): string {
  const lines: string[] = [];
  if (sample.shopName) lines.push(`Store name: ${sample.shopName}`);
  if (sample.shopDescription) lines.push(`Store description: ${sample.shopDescription}`);
  lines.push(`Content language: ${sample.primaryLocale}`);
  lines.push(
    `Catalogue size: ${sample.totals.products} products, ${sample.totals.collections} collections, ${sample.totals.menuItems} navigation items`,
  );
  for (const menu of sample.menus) {
    lines.push("", `Navigation menu "${menu.title}":`, ...menu.labels.map((label) => `  ${label}`));
  }
  if (sample.collections.length > 0) {
    lines.push("", "Collections:");
    for (const collection of sample.collections) {
      const count = collection.productsCount !== null ? ` (${collection.productsCount} products)` : "";
      const description = collection.description ? ` — ${collection.description}` : "";
      lines.push(`  ${collection.title}${count}${description}`);
    }
  }
  if (sample.vendors.length > 0)
    lines.push("", `Vendors: ${sample.vendors.map((v) => `${v.value} (${v.count})`).join(", ")}`);
  if (sample.productTypes.length > 0)
    lines.push("", `Product types: ${sample.productTypes.map((v) => `${v.value} (${v.count})`).join(", ")}`);
  if (sample.tags.length > 0)
    lines.push("", `Tags: ${sample.tags.map((v) => `${v.value} (${v.count})`).join(", ")}`);
  if (sample.optionNames.length > 0)
    lines.push(
      "",
      `Product options: ${sample.optionNames
        .map((option) => `${option.name}${option.values.length > 0 ? ` [${option.values.join(", ")}]` : ""}`)
        .join("; ")}`,
    );
  if (sample.productTitles.length > 0)
    lines.push("", "Product titles (a representative sample):", ...sample.productTitles.map((t) => `  ${t}`));
  if (sample.blogs.length > 0) lines.push("", `Blogs: ${sample.blogs.join(", ")}`);
  return lines.join("\n");
}
