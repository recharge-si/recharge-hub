/**
 * The one map from the engine's fields to the store's real attribute keys
 * (docs/rig-builder.md § Attributes the engine reads). They are the keys of
 * the store's own product plan, in the `recharge` namespace; a variant-scope
 * key falls back to the product's, and the other way round.
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
 * Plan type names that make a product a candidate for a role. A product is a
 * candidate when the type the plan resolves for it, or one of that type's
 * ancestors, has one of these names (case-insensitive) AND the path runs
 * through "Windsurf" (the plan also has Wing and SUP boards). "Bases and
 * extensions" is the old rig pack's single type; an extension is then the one
 * with extension_min_cm.
 */
export const ROLE_TYPE_NAMES: Readonly<
  Record<"board" | "sail" | "mast" | "boom" | "base" | "extension" | "fin", readonly string[]>
> = {
  board: ["Boards"],
  sail: ["Sails"],
  mast: ["Masts"],
  boom: ["Booms"],
  extension: ["Mast extensions"],
  base: ["Mast bases", "Bases and extensions"],
  fin: ["Fins"],
};
export const DISCIPLINE_TYPE_NAME = "Windsurf";

/** Every key the engine reads, by field, after `recharge.`. */
export const KEYS = {
  canopyArea: "canopy_area",
  luffCm: "luff_cm",
  boomMinCm: "boom_min_cm",
  boomMaxCm: "boom_max_cm",
  recommendedMastCm: "recommended_mast_cm",
  recommendedMastDiameter: "recommended_mast_diameter",
  recommendedMastImcs: "recommended_mast_imcs",
  compatibleMastDiameters: "compatible_mast_diameters",
  recommendedBoomCm: "recommended_boom_cm",
  lengthCm: "length_cm",
  mastDiameter: "mast_diameter",
  mastImcs: "mast_imcs",
  carbonPercent: "carbon_percent",
  extensionMinCm: "extension_min_cm",
  extensionMaxCm: "extension_max_cm",
  baseConnection: "base_connection",
  finBox: "fin_box",
  finBoxTypes: "fin_box_types",
  volumeL: "volume_l",
  boardSailMinM2: "board_sail_min_m2",
  boardSailMaxM2: "board_sail_max_m2",
  boardFinMinCm: "board_fin_min_cm",
  boardFinMaxCm: "board_fin_max_cm",
  riderMassMinKg: "rider_mass_min_kg",
  riderMassMaxKg: "rider_mass_max_kg",
} as const;

export type SpecField =
  | "areaM2"
  | "mastCm"
  | "mastDiameter"
  | "mastImcs"
  | "compatibleDiameters"
  | "recommendedBoomCm"
  | "lengthCm"
  | "carbonPercent"
  | "boomMinCm"
  | "boomMaxCm"
  | "extensionMinCm"
  | "extensionMaxCm"
  | "baseConnection"
  | "finBox"
  | "finLengthCm"
  | "finBoxTypes"
  | "volumeL"
  | "sailMinM2"
  | "sailMaxM2"
  | "finMinCm"
  | "finMaxCm"
  | "riderMinKg"
  | "riderMaxKg";

export type SpecValue = number | string | string[];
export type Specs = Partial<Record<SpecField, SpecValue>>;

/** How a stored value is read (values.ts). */
export type FieldKind = "cm" | "kg" | "m2" | "l" | "number" | "code" | "list";

export interface FieldSpec {
  field: SpecField;
  key: string;
  kind: FieldKind;
}

const f = (field: SpecField, key: string, kind: FieldKind): FieldSpec => ({
  field,
  key,
  kind,
});

/** What is read per role; the same field can sit on another key in another role. */
export const ROLE_FIELDS: Readonly<Record<RigRole, readonly FieldSpec[]>> = {
  sail: [
    f("areaM2", KEYS.canopyArea, "m2"),
    f("mastCm", KEYS.recommendedMastCm, "cm"),
    f("mastDiameter", KEYS.recommendedMastDiameter, "code"),
    f("mastImcs", KEYS.recommendedMastImcs, "number"),
    f("compatibleDiameters", KEYS.compatibleMastDiameters, "list"),
    f("boomMinCm", KEYS.boomMinCm, "cm"),
    f("boomMaxCm", KEYS.boomMaxCm, "cm"),
    f("recommendedBoomCm", KEYS.recommendedBoomCm, "cm"),
  ],
  mast: [
    f("lengthCm", KEYS.lengthCm, "cm"),
    f("mastDiameter", KEYS.mastDiameter, "code"),
    f("mastImcs", KEYS.mastImcs, "number"),
    f("carbonPercent", KEYS.carbonPercent, "number"),
  ],
  boom: [
    f("boomMinCm", KEYS.boomMinCm, "cm"),
    f("boomMaxCm", KEYS.boomMaxCm, "cm"),
    f("compatibleDiameters", KEYS.compatibleMastDiameters, "list"),
  ],
  extension: [
    f("extensionMinCm", KEYS.extensionMinCm, "cm"),
    f("extensionMaxCm", KEYS.extensionMaxCm, "cm"),
    f("baseConnection", KEYS.baseConnection, "code"),
    f("mastDiameter", KEYS.mastDiameter, "code"),
  ],
  base: [f("baseConnection", KEYS.baseConnection, "code")],
  fin: [
    f("finBox", KEYS.finBox, "code"),
    f("finLengthCm", KEYS.lengthCm, "cm"),
  ],
  board: [
    f("volumeL", KEYS.volumeL, "l"),
    f("sailMinM2", KEYS.boardSailMinM2, "m2"),
    f("sailMaxM2", KEYS.boardSailMaxM2, "m2"),
    f("finMinCm", KEYS.boardFinMinCm, "cm"),
    f("finMaxCm", KEYS.boardFinMaxCm, "cm"),
    f("finBoxTypes", KEYS.finBoxTypes, "list"),
    f("riderMinKg", KEYS.riderMassMinKg, "kg"),
    f("riderMaxKg", KEYS.riderMassMaxKg, "kg"),
  ],
};

/** The key of a field in a role, for messages. */
export function keyOf(role: RigRole, field: SpecField): string {
  return ROLE_FIELDS[role].find((spec) => spec.field === field)?.key ?? field;
}

/**
 * What a candidate needs to be placed in a rig (readiness "complete"): the
 * keys it lacks, in the order they are reported. A role the rules do not need
 * anything of returns none.
 *
 * - sail: the area.
 * - mast: the length and the diameter.
 * - boom: the minimum and the maximum.
 * - fin: the fin box.
 * - board: a volume or a sail range, and the fin box types.
 * - extension: its minimum and maximum.
 * - base: nothing (its connection is checked when there is data).
 */
export function placementGaps(role: RigRole, specs: Specs): string[] {
  const need = (field: SpecField) =>
    specs[field] === undefined ? [keyOf(role, field)] : [];
  switch (role) {
    case "sail":
      return need("areaM2");
    case "mast":
      return [...need("lengthCm"), ...need("mastDiameter")];
    case "boom":
      return [...need("boomMinCm"), ...need("boomMaxCm")];
    case "fin":
      return need("finBox");
    case "board": {
      const hasRange =
        specs.sailMinM2 !== undefined && specs.sailMaxM2 !== undefined;
      return [
        ...(specs.volumeL === undefined && !hasRange ? [KEYS.volumeL] : []),
        ...need("finBoxTypes"),
      ];
    }
    case "extension":
      return [...need("extensionMinCm"), ...need("extensionMaxCm")];
    case "base":
      return [];
  }
}

/** The roles readiness gates on (PRD 4 US-406); the base and extension are reported, not gating. */
export const READINESS_ROLES: readonly RigRole[] = [
  "board",
  "sail",
  "mast",
  "boom",
  "fin",
];
export const READINESS_MIN_COMPLETE = 3;

const ROLE_WORDS: Record<RigRole, string> = {
  board: "boards",
  sail: "sails",
  mast: "masts",
  extension: "extensions",
  base: "bases",
  boom: "booms",
  fin: "fins",
};

/** The plural a merchant reads in the readiness line. */
export function roleWord(role: RigRole): string {
  return ROLE_WORDS[role];
}

/** Every key the engine reads for any role, for "does the plan already cover it". */
export const ENGINE_KEYS: readonly string[] = [
  ...new Set(Object.values(ROLE_FIELDS).flatMap((fields) => fields.map((s) => s.key))),
].sort();
