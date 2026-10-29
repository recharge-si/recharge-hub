import type { ResetRequest } from "../fake-services/state";

/**
 * The rig catalogue the metafield specs share (PRD 2, test data setup):
 * 20 sails of which 12 hold everything the rig builder requires and 8 lack
 * `sail_boom_max_cm`; 6 masts (2 without `mast_imcs`); 10 boards (3 with no
 * fin box); 4 fins. The store already holds three definitions: one that
 * matches the plan, one with another type (a deliberate conflict) and one the
 * plan does not mention.
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

export interface RigFixtureCounts {
  sails: number;
  sailsComplete: number;
  masts: number;
  mastsWithoutImcs: number;
  boards: number;
  boardsWithoutFinBox: number;
  fins: number;
}

export const RIG_COUNTS: RigFixtureCounts = {
  sails: 20,
  sailsComplete: 12,
  masts: 6,
  mastsWithoutImcs: 2,
  boards: 10,
  boardsWithoutFinBox: 3,
  fins: 4,
};

export function rigProducts(counts: RigFixtureCounts = RIG_COUNTS): Product[] {
  counter = 0;
  const out: Product[] = [];
  for (let i = 0; i < counts.sails; i += 1) {
    const variant: Metafields = {
      "recharge.sail_area_m2": decimal(5 + i / 10),
      "recharge.sail_mast_rdm": text("30"),
      "recharge.sail_mast_length_min_cm": integer(430),
      "recharge.sail_mast_length_max_cm": integer(460),
      "recharge.sail_boom_min_cm": integer(160),
    };
    if (i < counts.sailsComplete)
      variant["recharge.sail_boom_max_cm"] = integer(190);
    out.push(
      product(
        "Sails",
        `Sail ${i + 1}`,
        { "recharge.sail_category": text("freeride") },
        variant,
      ),
    );
  }
  for (let i = 0; i < counts.masts; i += 1) {
    const mast: Metafields = {
      "recharge.mast_rdm": text("30"),
      "recharge.mast_base_type": text("tendon"),
    };
    if (i >= counts.mastsWithoutImcs) mast["recharge.mast_imcs"] = integer(21);
    out.push(
      product("Masts", `Mast ${i + 1}`, mast, {
        "recharge.mast_length_cm": integer(430),
      }),
    );
  }
  for (let i = 0; i < counts.boards; i += 1) {
    const board: Metafields = {};
    if (i >= counts.boardsWithoutFinBox)
      board["recharge.board_fin_box"] = text("powerbox");
    out.push(
      product("Boards", `Board ${i + 1}`, board, {
        "recharge.board_volume_l": decimal(100),
        "recharge.board_width_cm": decimal(60),
        "recharge.board_length_cm": integer(230),
        "recharge.board_min_sail_m2": decimal(4.5),
        "recharge.board_max_sail_m2": decimal(6.5),
      }),
    );
  }
  for (let i = 0; i < counts.fins; i += 1)
    out.push(
      product(
        "Fins",
        `Fin ${i + 1}`,
        { "recharge.fin_box": text("powerbox") },
        {
          "recharge.fin_length_cm": integer(36),
        },
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
