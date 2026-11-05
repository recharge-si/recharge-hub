import type {
  Attribute,
  AttributeSchema,
  DataType,
  Scope,
} from "~/domain/attributes/types";
import type { ValuesProduct } from "~/domain/values/types";

import { rigPlan } from "./rig-fixtures";

/**
 * A plan with the store's real keys and stored shapes (the production data
 * brief): the rig plan's types, with the attributes the rig engine reads
 * attached to Sails, Masts, Booms and Boards, and a small catalogue holding
 * values exactly as Shopify stores them.
 */

export const SHOP = "values-shop.myshopify.com";

let counter = 0;
function attribute(
  name: string,
  key: string,
  dataType: DataType,
  options: { unit?: string; scope?: Scope; list?: string } = {},
): Attribute {
  counter += 1;
  return {
    id: `a${counter}`,
    name,
    setId: null,
    dataType,
    unit: options.unit ?? "",
    description: "",
    scope: options.scope ?? "variant",
    key,
    implementation: "custom",
    requiredDefault: false,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId: options.list ?? null,
  };
}

export function valuesPlan(): AttributeSchema {
  const plan = rigPlan();
  plan.valueLists = [
    {
      id: "diam",
      items: [
        { code: "rdm", en: "RDM", si: "RDM" },
        { code: "sdm", en: "SDM", si: "SDM" },
      ],
    },
    {
      id: "fin-box",
      items: [
        { code: "power_box", en: "Power Box", si: "Power Box" },
        { code: "tuttle", en: "Tuttle", si: "Tuttle" },
        { code: "deep_tuttle", en: "Deep Tuttle", si: "Deep Tuttle" },
      ],
    },
  ];
  const cm = { unit: "cm" };
  const attrs = {
    canopy: attribute("Sail area", "recharge.canopy_area", "measurement", {
      unit: "m2",
    }),
    luff: attribute("Luff", "recharge.luff_cm", "measurement", cm),
    boomMin: attribute("Boom min", "recharge.boom_min_cm", "measurement", cm),
    boomMax: attribute("Boom max", "recharge.boom_max_cm", "measurement", cm),
    mastCm: attribute(
      "Recommended mast",
      "recharge.recommended_mast_cm",
      "measurement",
      cm,
    ),
    mastDiam: attribute(
      "Recommended mast diameter",
      "recharge.recommended_mast_diameter",
      "single_select",
      { list: "diam" },
    ),
    compat: attribute(
      "Compatible mast diameters",
      "recharge.compatible_mast_diameters",
      "multi_select",
      { list: "diam" },
    ),
    length: attribute("Length", "recharge.length_cm", "measurement", cm),
    mastDiameter: attribute(
      "Mast diameter",
      "recharge.mast_diameter",
      "single_select",
      { list: "diam" },
    ),
    carbon: attribute("Carbon percent", "recharge.carbon_percent", "decimal", {
      scope: "product",
    }),
    imcs: attribute("IMCS", "recharge.mast_imcs", "decimal"),
    volume: attribute("Volume", "recharge.volume_l", "measurement", {
      unit: "l",
    }),
    finBoxTypes: attribute(
      "Fin box types",
      "recharge.fin_box_types",
      "multi_select",
      { list: "fin-box" },
    ),
    finsIncluded: attribute(
      "Fins included",
      "recharge.fins_included",
      "boolean",
    ),
    note: attribute("Note", "recharge.note", "text"),
  };
  plan.attributes = Object.values(attrs);
  const attach = (typeId: string, ...list: Attribute[]) =>
    list.forEach((item) =>
      plan.attributeAssignments.push({
        id: `as-${typeId}-${item.id}`,
        typeId,
        attributeId: item.id,
      }),
    );
  attach(
    "sails",
    attrs.canopy,
    attrs.luff,
    attrs.boomMin,
    attrs.boomMax,
    attrs.mastCm,
    attrs.mastDiam,
    attrs.compat,
    attrs.note,
  );
  attach(
    "masts",
    attrs.length,
    attrs.mastDiameter,
    attrs.carbon,
    attrs.imcs,
    attrs.note,
  );
  attach("booms", attrs.boomMin, attrs.boomMax, attrs.compat);
  attach("boards", attrs.volume, attrs.finBoxTypes, attrs.finsIncluded);
  return plan;
}

/** `{"value":37.0,"unit":"CENTIMETERS"}` as Shopify stores a dimension. */
export const dimension = (value: number, unit = "CENTIMETERS") => ({
  type: "dimension",
  value: JSON.stringify({ value, unit }),
});

export const decimal = (value: string) => ({
  type: "number_decimal",
  value,
});

export const text = (value: string) => ({
  type: "single_line_text_field",
  value,
});

export const list = (...values: string[]) => ({
  type: "list.single_line_text_field",
  value: JSON.stringify(values),
});

const variant = (
  id: number,
  title: string,
  metafields: ValuesProduct["variants"][number]["metafields"] = {},
  sku: string | null = null,
) => ({
  variantId: `gid://shopify/ProductVariant/${id}`,
  sku,
  title,
  options: [title],
  metafields,
});

/** Products typed by Shopify product type, as the snapshot holds them. */
export function valuesCatalogue(): ValuesProduct[] {
  return [
    {
      productId: "gid://shopify/Product/100",
      title: "Loftsails Team Edition III C100 RDM",
      vendor: "Loftsails",
      productType: "Masts",
      categoryName: null,
      chosenTypeId: null,
      metafields: { "recharge.carbon_percent": decimal("100.0") },
      variants: [
        variant(1001, "370", { "recharge.mast_diameter": text("rdm") }, "M-370"),
        variant(1002, "430", { "recharge.length_cm": dimension(430) }, "M-430"),
        variant(1003, "460"),
      ],
    },
    {
      productId: "gid://shopify/Product/200",
      title: "Gaastra Vapor",
      vendor: "Gaastra",
      productType: "Freeride sails",
      categoryName: null,
      chosenTypeId: null,
      metafields: {},
      variants: [
        variant(2001, "5.8 m2 / Orange", {
          "recharge.canopy_area": decimal("5.8"),
          "recharge.compatible_mast_diameters": list("rdm", "sdm"),
        }),
        variant(2002, "6.4 m2 / Orange", {
          "recharge.canopy_area": decimal("6.4"),
          "recharge.boom_min_cm": dimension(170),
        }),
        variant(2003, "7.0 m2 / Orange"),
      ],
    },
    {
      productId: "gid://shopify/Product/300",
      title: "Patrik Carbon L-Curve Boom",
      vendor: "Patrik International",
      productType: "Booms",
      categoryName: null,
      chosenTypeId: null,
      metafields: {},
      variants: [variant(3001, "160"), variant(3002, "170")],
    },
    {
      productId: "gid://shopify/Product/400",
      title: "Exocet Cross V7",
      vendor: "Exocet",
      productType: "Freeride boards",
      categoryName: null,
      chosenTypeId: null,
      metafields: {},
      variants: [variant(4001, "104"), variant(4002, "84")],
    },
  ];
}
