import { clip, stripHtml } from "~/domain/translations/text";

/**
 * Where a piece of text appears (docs/translations.md § Resource context).
 * A menu label is read with its siblings, an option value with its product,
 * a collection with a few of its products, a metafield with its
 * definition. The adapter gathers the facts from Shopify; this names the
 * shapes and renders each as a few lines the model reads before the fields.
 *
 * Nothing irrelevant is carried: no prices, no inventory, no customers.
 */

export type ResourceContext =
  | { kind: "menu"; labels: string[] }
  | {
      kind: "menu_item";
      menuTitle: string | null;
      /** Ancestor labels, outermost first. */
      parents: string[];
      /** Labels at the same level, including this item, in menu order. */
      siblings: string[];
      children: string[];
      /** What the link points at, as a kind: "collection", "product", "page", "url". */
      linksTo: string | null;
    }
  | {
      kind: "product";
      vendor: string | null;
      productType: string | null;
      tags: string[];
      collections: string[];
      options: Array<{ name: string; values: string[] }>;
    }
  | {
      kind: "product_option";
      productTitle: string | null;
      vendor: string | null;
      productType: string | null;
      values: string[];
    }
  | {
      kind: "product_option_value";
      productTitle: string | null;
      optionName: string | null;
      siblingValues: string[];
    }
  | { kind: "collection"; productsCount: number | null; sampleProducts: string[] }
  | { kind: "article"; blogTitle: string | null }
  | {
      kind: "metafield";
      ownerTitle: string | null;
      ownerKind: string | null;
      namespace: string | null;
      key: string | null;
      definitionName: string | null;
      definitionDescription: string | null;
    }
  | { kind: "none" };

const LIST_CAP = 24;

function list(values: readonly string[], cap = LIST_CAP): string {
  const shown = values.slice(0, cap).map((value) => clip(stripHtml(value), 60));
  const more = values.length - shown.length;
  return shown.join(" · ") + (more > 0 ? ` · (+${more} more)` : "");
}

/**
 * The context as the model reads it. Each line is a fact about where the
 * text sits; the header names the kind of resource and its title, so a
 * string of the fields is never read without knowing what it belongs to.
 */
export function renderResourceContext(
  context: ResourceContext,
  resource: { kind: string; title: string | null },
): string {
  const lines: string[] = [`Resource type: ${resource.kind}`];
  if (resource.title) lines.push(`Title: ${clip(stripHtml(resource.title), 120)}`);
  switch (context.kind) {
    case "menu":
      if (context.labels.length > 0) lines.push(`Menu items: ${list(context.labels, 40)}`);
      break;
    case "menu_item":
      if (context.menuTitle) lines.push(`Menu: ${context.menuTitle}`);
      lines.push(`Parent: ${context.parents.length > 0 ? context.parents.join(" › ") : "none (top level)"}`);
      if (context.siblings.length > 0) lines.push(`Items at this level, in order: ${list(context.siblings, 40)}`);
      if (context.children.length > 0) lines.push(`Sub-items of this item: ${list(context.children)}`);
      if (context.linksTo) lines.push(`Links to: a ${context.linksTo}`);
      break;
    case "product":
      if (context.vendor) lines.push(`Vendor: ${context.vendor}`);
      if (context.productType) lines.push(`Product type: ${context.productType}`);
      if (context.collections.length > 0) lines.push(`In collections: ${list(context.collections, 8)}`);
      if (context.tags.length > 0) lines.push(`Tags: ${list(context.tags, 12)}`);
      if (context.options.length > 0)
        lines.push(
          `Options: ${context.options
            .map((option) => `${option.name}${option.values.length > 0 ? ` (${list(option.values, 6)})` : ""}`)
            .join("; ")}`,
        );
      break;
    case "product_option":
      if (context.productTitle) lines.push(`Product: ${clip(context.productTitle, 100)}`);
      if (context.vendor) lines.push(`Vendor: ${context.vendor}`);
      if (context.productType) lines.push(`Product type: ${context.productType}`);
      if (context.values.length > 0) lines.push(`Values of this option: ${list(context.values, 12)}`);
      break;
    case "product_option_value":
      if (context.productTitle) lines.push(`Product: ${clip(context.productTitle, 100)}`);
      if (context.optionName) lines.push(`Option: ${context.optionName}`);
      if (context.siblingValues.length > 0) lines.push(`Other values of this option: ${list(context.siblingValues, 12)}`);
      break;
    case "collection":
      if (context.productsCount !== null) lines.push(`Products in the collection: ${context.productsCount}`);
      if (context.sampleProducts.length > 0) lines.push(`Some of its products: ${list(context.sampleProducts, 10)}`);
      break;
    case "article":
      if (context.blogTitle) lines.push(`Blog: ${context.blogTitle}`);
      break;
    case "metafield":
      if (context.ownerTitle || context.ownerKind)
        lines.push(`Belongs to: ${[context.ownerKind, context.ownerTitle ? `"${clip(context.ownerTitle, 80)}"` : null].filter(Boolean).join(" ")}`);
      if (context.definitionName) lines.push(`Field: ${context.definitionName}`);
      if (context.definitionDescription) lines.push(`Field description: ${clip(context.definitionDescription, 200)}`);
      if (!context.definitionName && context.namespace && context.key) lines.push(`Field key: ${context.namespace}.${context.key}`);
      break;
    case "none":
      break;
  }
  return lines.join("\n");
}
