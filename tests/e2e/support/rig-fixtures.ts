import type { ResetRequest } from "../fake-services/state";

/**
 * The rig catalogue the metafield specs share, on the keys the store really
 * holds (docs/rig-builder.md): 20 sails of which 12 hold a canopy_area and 8
 * do not; 6 masts (2 without a mast_diameter); 10 boards (3 with no
 * fin_box_types); 4 fins; no booms. The store already holds three
 * definitions: one that matches the plan, one with another type (a deliberate
 * conflict) and one the plan does not mention.
 */

type Product = NonNullable<
  NonNullable<ResetRequest["shopify"]>["products"]
>[number];
type Metafields = Record<string, { type: string; value: string }>;

const text = (value: string) => ({ type: "single_line_text_field", value });
const integer = (value: number) => ({
  type: "number_integer",
  value: String(value),
});
const decimal = (value: number) => ({
  type: "number_decimal",
  value: String(value),
});

let counter = 0;

function product(
  productType: string,
  title: string,
  product: Metafields,
  variant: Metafields,
): Product {
  counter += 1;
  return {
    id: `gid://shopify/Product/${1000 + counter}`,
    title,
    handle: `${productType.toLowerCase()}-${counter}`,
    status: "ACTIVE",
    vendor: "Point-7",
    productType,
    tags: [],
    descriptionHtml: "",
    metafields: product,
    variants: [
      {
        id: `gid://shopify/ProductVariant/${5000 + counter}`,
        title: "Default",
        sku: `SKU-${counter}`,
        price: "100.00",
        compareAtPrice: null,
        inventory: {},
        metafields: variant,
      },
    ],
  };
}

const list = (...values: string[]) => ({
  type: "list.single_line_text_field",
  value: JSON.stringify(values),
});

export interface RigFixtureCounts {
  sails: number;
  sailsComplete: number;
  masts: number;
  mastsWithoutDiameter: number;
  boards: number;
  boardsWithoutFinBoxTypes: number;
  fins: number;
}

export const RIG_COUNTS: RigFixtureCounts = {
  sails: 20,
  sailsComplete: 12,
  masts: 6,
  mastsWithoutDiameter: 2,
  boards: 10,
  boardsWithoutFinBoxTypes: 3,
  fins: 4,
};

export function rigProducts(counts: RigFixtureCounts = RIG_COUNTS): Product[] {
  counter = 0;
  const out: Product[] = [];
  for (let i = 0; i < counts.sails; i += 1) {
    const variant: Metafields = {};
    if (i < counts.sailsComplete)
      variant["recharge.canopy_area"] = decimal(5 + i / 10);
    out.push(product("Sails", `Sail ${i + 1}`, {}, variant));
  }
  for (let i = 0; i < counts.masts; i += 1) {
    const mast: Metafields = {};
    if (i >= counts.mastsWithoutDiameter)
      mast["recharge.mast_diameter"] = text("rdm");
    out.push(
      product("Masts", `Mast ${i + 1}`, mast, {
        "recharge.length_cm": integer(430),
      }),
    );
  }
  for (let i = 0; i < counts.boards; i += 1) {
    const board: Metafields = {};
    if (i >= counts.boardsWithoutFinBoxTypes)
      board["recharge.fin_box_types"] = list("power_box");
    out.push(
      product("Boards", `Board ${i + 1}`, board, {
        "recharge.volume_l": decimal(100),
      }),
    );
  }
  for (let i = 0; i < counts.fins; i += 1)
    out.push(
      product(
        "Fins",
        `Fin ${i + 1}`,
        { "recharge.fin_box": text("power_box") },
        { "recharge.length_cm": integer(36) },
      ),
    );
  return out;
}

/** Definitions the store already holds: a match, a conflict and a stranger. */
export const EXISTING_DEFINITIONS = [
  {
    ownerType: "PRODUCTVARIANT" as const,
    namespace: "recharge",
    key: "sail_size",
    name: "Sail size",
    type: "number_decimal",
  },
  {
    ownerType: "PRODUCT" as const,
    namespace: "recharge",
    key: "skill_level",
    name: "Skill level",
    type: "multi_line_text_field",
  },
  {
    ownerType: "PRODUCT" as const,
    namespace: "custom",
    key: "warranty",
    name: "Warranty",
    type: "single_line_text_field",
  },
];
