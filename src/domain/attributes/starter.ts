import {
  SCHEMA_VERSION,
  type AttributeSchema,
} from "~/domain/attributes/types";

/**
 * The starter schema: a small, working example of the shape the store's
 * catalogue takes — sails and boards under windsurfing, wetsuits under
 * clothing — that a shop can begin from rather than from nothing. It is
 * loaded only when asked for, never on its own.
 */
export function starterSchema(): AttributeSchema {
  const type = (
    id: string,
    name: string,
    parentId: string | null,
    leaf: boolean,
    sortOrder: number,
    shopifyCategory = "",
  ) => ({
    id,
    name,
    parentId,
    leaf,
    sortOrder,
    shopifyCategory,
    archetype: "",
  });

  return {
    version: SCHEMA_VERSION,
    types: [
      type("all", "All products", null, false, 1000),
      type("windsurf", "Windsurf", "all", false, 1000),
      type("sails", "Sails", "windsurf", false, 1000),
      type(
        "wave",
        "Wave sails",
        "sails",
        true,
        1000,
        "Sporting Goods > Water Sports > Windsurfing",
      ),
      type("freeride", "Freeride sails", "sails", true, 2000),
      type("boards", "Boards", "windsurf", false, 2000),
      type("waveboard", "Wave boards", "boards", true, 1000),
      type("clothing", "Clothing", "all", false, 2000),
      type("wetsuits", "Wetsuits", "clothing", true, 1000),
    ],
    sets: [
      {
        id: "core",
        name: "Core product information",
        description: "Shared by every product",
      },
      {
        id: "sail",
        name: "Sail specifications",
        description: "Sizing and rigging details",
      },
      {
        id: "board",
        name: "Board specifications",
        description: "Dimensions and construction",
      },
      {
        id: "clothes",
        name: "Clothing sizing",
        description: "Wearable product sizing",
      },
    ],
    attributes: [
      attribute("brand", "Brand", "core", "text", "product", "recharge.brand", {
        requiredDefault: true,
        filterable: true,
      }),
      attribute("model", "Model", "core", "text", "product", "recharge.model", {
        requiredDefault: true,
        searchable: true,
      }),
      attribute(
        "year",
        "Model year",
        "core",
        "integer",
        "product",
        "recharge.model_year",
        { filterable: true },
      ),
      attribute(
        "sailsize",
        "Sail size",
        "sail",
        "measurement",
        "variant",
        "recharge.sail_size",
        {
          unit: "m²",
          requiredDefault: true,
          filterable: true,
          comparable: true,
        },
      ),
      attribute(
        "luff",
        "Luff length",
        "sail",
        "measurement",
        "variant",
        "recharge.luff_cm",
        { unit: "cm", requiredDefault: true, comparable: true },
      ),
      attribute(
        "boom",
        "Boom range",
        "sail",
        "text",
        "variant",
        "recharge.boom_range",
        { unit: "cm", requiredDefault: true, comparable: true },
      ),
      attribute(
        "skill",
        "Skill level",
        "sail",
        "single_select",
        "product",
        "recharge.skill_level",
        { filterable: true, valueListId: "skill" },
      ),
      attribute(
        "volume",
        "Volume",
        "board",
        "measurement",
        "variant",
        "recharge.volume_l",
        {
          unit: "L",
          requiredDefault: true,
          filterable: true,
          comparable: true,
        },
      ),
      attribute(
        "width",
        "Width",
        "board",
        "measurement",
        "variant",
        "recharge.width_cm",
        { unit: "cm", requiredDefault: true, comparable: true },
      ),
      attribute(
        "size",
        "Clothing size",
        "clothes",
        "single_select",
        "variant",
        "recharge.clothing_size",
        {
          requiredDefault: true,
          filterable: true,
          valueListId: "clothing_size",
        },
      ),
    ],
    setAssignments: [
      { id: "sa1", typeId: "all", setId: "core" },
      { id: "sa2", typeId: "sails", setId: "sail" },
      { id: "sa3", typeId: "boards", setId: "board" },
      { id: "sa4", typeId: "clothing", setId: "clothes" },
    ],
    attributeAssignments: [],
    overrides: [
      {
        id: "ov1",
        typeId: "wave",
        attributeId: "skill",
        required: true,
        reason: "Important for wave sail selection",
      },
    ],
    exclusions: [],
    valueLists: [
      {
        id: "skill",
        items: [
          { code: "beginner", en: "Beginner", si: "Začetnik" },
          { code: "advanced", en: "Advanced", si: "Napredno" },
        ],
      },
      {
        id: "clothing_size",
        items: [
          { code: "s", en: "S", si: "S" },
          { code: "m", en: "M", si: "M" },
          { code: "l", en: "L", si: "L" },
        ],
      },
    ],
  };
}

function attribute(
  id: string,
  name: string,
  setId: string,
  dataType: AttributeSchema["attributes"][number]["dataType"],
  scope: "product" | "variant",
  key: string,
  extra: Partial<AttributeSchema["attributes"][number]> = {},
): AttributeSchema["attributes"][number] {
  return {
    id,
    name,
    setId,
    dataType,
    unit: "",
    description: "",
    scope,
    key,
    implementation: "custom",
    requiredDefault: false,
    filterable: false,
    searchable: false,
    comparable: false,
    valueListId: null,
    ...extra,
  };
}
