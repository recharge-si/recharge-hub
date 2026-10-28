/**
 * The attribute keys the rig engine reads (docs/rig-builder.md § Attributes
 * the engine reads). They are the keys of the rig attribute pack (PRD 2
 * US-204, `domain/attributes/rig-pack.ts` on the metafields branch), defined
 * here so this module does not depend on that branch. Every key lives in the
 * `recharge` namespace; a variant-scope key falls back to the product's, and
 * the other way round, so the plan may attach either.
 */

export const RIG_NAMESPACE = "recharge";

export const RIG_ROLES = [
  "board",
  "sail",
  "mast",
  "extension",
  "base",
  "boom",
  "fin",
] as const;
export type RigRole = (typeof RIG_ROLES)[number];

/**
 * The plan's product type that makes a product a candidate for a role. A
 * product is a candidate when the type the plan resolves for it, or one of
 * that type's ancestors, has this name (case-insensitive). The base and the
 * extension are one type in the pack ("Bases and extensions"); an extension
 * is the one with `extension_length_cm`.
 */
export const ROLE_TYPE_NAMES: Readonly<Record<"board" | "sail" | "mast" | "boom" | "base" | "fin", string>> = {
  board: "Boards",
  sail: "Sails",
  mast: "Masts",
  boom: "Booms",
  base: "Bases and extensions",
  fin: "Fins",
};

/** The attribute keys (after `recharge.`) of each candidate field. */
export const KEYS = {
  sailAreaM2: "sail_area_m2",
  sailMastRdm: "sail_mast_rdm",
  sailMastLengthMinCm: "sail_mast_length_min_cm",
  sailMastLengthMaxCm: "sail_mast_length_max_cm",
  sailBoomMinCm: "sail_boom_min_cm",
  sailBoomMaxCm: "sail_boom_max_cm",
  sailCategory: "sail_category",
  mastLengthCm: "mast_length_cm",
  mastRdm: "mast_rdm",
  mastBaseType: "mast_base_type",
  boardVolumeL: "board_volume_l",
  boardFinBox: "board_fin_box",
  boardMinSailM2: "board_min_sail_m2",
  boardMaxSailM2: "board_max_sail_m2",
  boomMinCm: "boom_min_cm",
  boomMaxCm: "boom_max_cm",
  baseType: "base_type",
  extensionLengthCm: "extension_length_cm",
  finBox: "fin_box",
  finLengthCm: "fin_length_cm",
} as const;

export type SpecField =
  | "areaM2"
  | "mastRdm"
  | "mastLengthMinCm"
  | "mastLengthMaxCm"
  | "boomMinCm"
  | "boomMaxCm"
  | "category"
  | "lengthCm"
  | "baseType"
  | "volumeL"
  | "finBox"
  | "minSailM2"
  | "maxSailM2"
  | "extensionLengthCm"
  | "finLengthCm";

/**
 * Which key fills which field, and whether a role needs it. A variant that
 * lacks a required field is never chosen and is counted under its key, so
 * coverage gaps are visible (PRD 4 US-403, feeding PRD 2 US-207).
 * `kind` says how the stored text is read.
 */
export interface FieldSpec {
  field: SpecField;
  key: string;
  kind: "number" | "code";
}

export const ROLE_FIELDS: Readonly<
  Record<RigRole, { required: readonly FieldSpec[]; optional: readonly FieldSpec[] }>
> = {
  sail: {
    required: [
      { field: "areaM2", key: KEYS.sailAreaM2, kind: "number" },
      { field: "mastRdm", key: KEYS.sailMastRdm, kind: "code" },
      { field: "mastLengthMinCm", key: KEYS.sailMastLengthMinCm, kind: "number" },
      { field: "mastLengthMaxCm", key: KEYS.sailMastLengthMaxCm, kind: "number" },
      { field: "boomMinCm", key: KEYS.sailBoomMinCm, kind: "number" },
      { field: "boomMaxCm", key: KEYS.sailBoomMaxCm, kind: "number" },
      { field: "category", key: KEYS.sailCategory, kind: "code" },
    ],
    optional: [],
  },
  mast: {
    required: [
      { field: "lengthCm", key: KEYS.mastLengthCm, kind: "number" },
      { field: "mastRdm", key: KEYS.mastRdm, kind: "code" },
      { field: "baseType", key: KEYS.mastBaseType, kind: "code" },
    ],
    optional: [],
  },
  board: {
    required: [
      { field: "volumeL", key: KEYS.boardVolumeL, kind: "number" },
      { field: "finBox", key: KEYS.boardFinBox, kind: "code" },
      { field: "minSailM2", key: KEYS.boardMinSailM2, kind: "number" },
      { field: "maxSailM2", key: KEYS.boardMaxSailM2, kind: "number" },
    ],
    optional: [],
  },
  boom: {
    required: [
      { field: "boomMinCm", key: KEYS.boomMinCm, kind: "number" },
      { field: "boomMaxCm", key: KEYS.boomMaxCm, kind: "number" },
    ],
    optional: [],
  },
  base: {
    required: [{ field: "baseType", key: KEYS.baseType, kind: "code" }],
    optional: [],
  },
  extension: {
    required: [
      { field: "extensionLengthCm", key: KEYS.extensionLengthCm, kind: "number" },
    ],
    optional: [{ field: "baseType", key: KEYS.baseType, kind: "code" }],
  },
  fin: {
    required: [
      { field: "finBox", key: KEYS.finBox, kind: "code" },
      { field: "finLengthCm", key: KEYS.finLengthCm, kind: "number" },
    ],
    optional: [],
  },
};

/** The roles readiness gates on (PRD 4 US-406); the base is reported, not gating. */
export const READINESS_ROLES: readonly RigRole[] = [
  "board",
  "sail",
  "mast",
  "boom",
  "fin",
];
export const READINESS_MIN_COMPLETE = 3;
