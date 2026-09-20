import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  emptyFacts,
  readMenus,
  readNodeFacts,
  type NodeFacts,
} from "~/adapters/shopify/store-context";
import type { ResourceContext } from "~/domain/translations/context";
import type { SnapshotMenu, SnapshotMenuItem } from "~/domain/translations/snapshot";
import type { ResourceType } from "~/domain/translations/types";

/**
 * Where each resource of a pass sits (docs/translations.md § Resource
 * context), read once per pass and answered per resource.
 *
 * `prime` takes the page's resources and makes the few Shopify reads they
 * need — one `nodes` query for products, collections, articles, metafields
 * and options, and the menus once for the whole pass — so `contextFor` is
 * a lookup. A resource nothing was found for gets `{ kind: "none" }` and is
 * translated with the store context and terminology alone.
 */

interface PlacedItem {
  menuTitle: string;
  parents: string[];
  siblings: string[];
  children: string[];
  linksTo: string | null;
}

const NODE_TYPES: ReadonlySet<ResourceType> = new Set([
  "PRODUCT",
  "COLLECTION",
  "ARTICLE",
  "METAFIELD",
  "PRODUCT_OPTION",
  "PRODUCT_OPTION_VALUE",
]);

function numericId(gid: string): string | null {
  return /\/(\d+)(?:\?.*)?$/.exec(gid)?.[1] ?? null;
}

function linkKind(type: string | null): string | null {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "http") return "URL";
  if (lower === "frontpage") return "home page";
  if (lower === "catalog") return "catalogue of all products";
  return lower.replace(/_/g, " ");
}

/** Every item of every menu, placed among its parents, siblings and children. */
function placeMenuItems(menus: readonly SnapshotMenu[]): { byNumericId: Map<string, PlacedItem>; byTitle: Map<string, PlacedItem[]> } {
  const byNumericId = new Map<string, PlacedItem>();
  const byTitle = new Map<string, PlacedItem[]>();
  const walk = (menu: SnapshotMenu, items: readonly SnapshotMenuItem[], parents: string[]) => {
    const siblings = items.map((item) => item.title.trim()).filter((title) => title !== "");
    for (const item of items) {
      const placed: PlacedItem = {
        menuTitle: menu.title,
        parents,
        siblings,
        children: item.items.map((child) => child.title.trim()).filter((title) => title !== ""),
        linksTo: linkKind(item.type),
      };
      const id = numericId(item.id);
      if (id) byNumericId.set(id, placed);
      const key = item.title.trim().toLowerCase();
      byTitle.set(key, [...(byTitle.get(key) ?? []), placed]);
      walk(menu, item.items, [...parents, item.title.trim()]);
    }
  };
  for (const menu of menus) walk(menu, menu.items, []);
  return { byNumericId, byTitle };
}

/** What the engine asks of a context source; `ContextSource` reads Shopify, a test may not. */
export interface ResourceContexts {
  prime(resources: ReadonlyArray<{ resourceId: string; type: ResourceType }>): Promise<void>;
  contextFor(resourceId: string, type: ResourceType, title: string | null): Promise<ResourceContext>;
  neighbourText(resourceId: string, type: ResourceType, title: string | null): Promise<string[]>;
}

export class ContextSource implements ResourceContexts {
  private menus: Promise<readonly SnapshotMenu[]> | null = null;
  private placed: ReturnType<typeof placeMenuItems> | null = null;
  private facts: NodeFacts = emptyFacts();

  constructor(private readonly admin: AdminApiContext) {}

  private async loadMenus(): Promise<void> {
    if (!this.menus) this.menus = readMenus(this.admin).catch(() => []);
    if (!this.placed) this.placed = placeMenuItems(await this.menus);
  }

  /** Reads what a page of resources will need. Safe to call more than once. */
  async prime(resources: ReadonlyArray<{ resourceId: string; type: ResourceType }>): Promise<void> {
    const nodeIds = resources
      .filter((resource) => NODE_TYPES.has(resource.type))
      .map((resource) => resource.resourceId)
      .filter((id) => !this.known(id));
    const needsMenus = resources.some((resource) => resource.type === "MENU" || resource.type === "LINK");
    const [facts] = await Promise.all([
      nodeIds.length > 0 ? readNodeFacts(this.admin, nodeIds).catch(() => emptyFacts()) : Promise.resolve(emptyFacts()),
      needsMenus ? this.loadMenus() : Promise.resolve(),
    ]);
    for (const [id, value] of facts.products) this.facts.products.set(id, value);
    for (const [id, value] of facts.collections) this.facts.collections.set(id, value);
    for (const [id, value] of facts.articles) this.facts.articles.set(id, value);
    for (const [id, value] of facts.metafields) this.facts.metafields.set(id, value);
    for (const [id, value] of facts.options) this.facts.options.set(id, value);
    for (const [id, value] of facts.optionValues) this.facts.optionValues.set(id, value);
  }

  private known(id: string): boolean {
    return (
      this.facts.products.has(id) ||
      this.facts.collections.has(id) ||
      this.facts.articles.has(id) ||
      this.facts.metafields.has(id) ||
      this.facts.options.has(id) ||
      this.facts.optionValues.has(id)
    );
  }

  /**
   * The context of one resource. `title` is the resource's own title as
   * Shopify's translatable content gives it, used to place a menu link
   * whose id does not match a menu item (Shopify's `Link` ids are the menu
   * item's in practice; the title is the fallback).
   */
  async contextFor(resourceId: string, type: ResourceType, title: string | null): Promise<ResourceContext> {
    switch (type) {
      case "MENU": {
        await this.loadMenus();
        const id = numericId(resourceId);
        const menu = (await this.menus!).find((m) => numericId(m.id) === id) ?? null;
        if (!menu) return { kind: "none" };
        return { kind: "menu", labels: menu.items.map((item) => item.title.trim()).filter((t) => t !== "") };
      }
      case "LINK": {
        await this.loadMenus();
        const id = numericId(resourceId);
        const byId = id ? this.placed!.byNumericId.get(id) : undefined;
        const candidates = title ? (this.placed!.byTitle.get(title.trim().toLowerCase()) ?? []) : [];
        const placed = byId ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!placed) return { kind: "none" };
        return { kind: "menu_item", ...placed };
      }
      case "PRODUCT": {
        const product = this.facts.products.get(resourceId);
        if (!product) return { kind: "none" };
        return {
          kind: "product",
          vendor: product.vendor,
          productType: product.productType,
          tags: product.tags,
          collections: product.collections,
          options: product.options.map((option) => ({
            name: option.name,
            values: option.values.map((value) => value.name),
          })),
        };
      }
      case "PRODUCT_OPTION": {
        const option = this.facts.options.get(resourceId);
        if (!option) return { kind: "none" };
        return { kind: "product_option", productTitle: null, vendor: null, productType: null, values: option.values };
      }
      case "PRODUCT_OPTION_VALUE":
        return { kind: "none" };
      case "COLLECTION": {
        const collection = this.facts.collections.get(resourceId);
        if (!collection) return { kind: "none" };
        return { kind: "collection", productsCount: collection.productsCount, sampleProducts: collection.sampleProducts };
      }
      case "ARTICLE": {
        const article = this.facts.articles.get(resourceId);
        return { kind: "article", blogTitle: article?.blogTitle ?? null };
      }
      case "METAFIELD": {
        const metafield = this.facts.metafields.get(resourceId);
        if (!metafield) return { kind: "none" };
        return {
          kind: "metafield",
          ownerTitle: metafield.ownerTitle,
          ownerKind: metafield.ownerKind,
          namespace: metafield.namespace,
          key: metafield.key,
          definitionName: metafield.definitionName,
          definitionDescription: metafield.definitionDescription,
        };
      }
      default:
        return { kind: "none" };
    }
  }

  /** Text near a resource, for language detection: siblings of a menu link, a product's collections. */
  async neighbourText(resourceId: string, type: ResourceType, title: string | null): Promise<string[]> {
    const context = await this.contextFor(resourceId, type, title);
    switch (context.kind) {
      case "menu":
        return context.labels;
      case "menu_item":
        return [...context.parents, ...context.siblings.filter((s) => s !== title), ...context.children];
      case "product":
        return [...context.collections, ...context.tags, ...context.options.map((o) => o.name)];
      case "collection":
        return context.sampleProducts;
      case "product_option":
        return context.values;
      case "article":
        return context.blogTitle ? [context.blogTitle] : [];
      case "metafield":
        return [context.ownerTitle, context.definitionName].filter((t): t is string => t !== null);
      default:
        return [];
    }
  }
}
