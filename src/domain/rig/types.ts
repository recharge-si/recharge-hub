import type { RigRole, SpecField, Specs } from "~/domain/rig/keys";

/** A part of a rig as the engine sees it: one purchasable variant. */
export interface RigCandidate {
  role: RigRole;
  shopId: string;
  /** Shopify product GID. */
  productId: string;
  /** Shopify variant GID. */
  variantGid: string;
  /** The numeric tail of the variant GID, what `/cart/add.js` takes. */
  variantId: number;
  /** ACTIVE, DRAFT or ARCHIVED, as Shopify says. */
  status: string;
  title: string;
  variantTitle: string | null;
  handle: string | null;
  imageUrl: string | null;
  priceMinor: number;
  currency: string;
  inStock: boolean;
  /** Units, when the snapshot knows them; null means unknown, and unknown is not in stock. */
  inventoryQuantity: number | null;
  /** Numbers and codes read off the metafields (or derived), by field. */
  specs: Specs;
  /** The fields whose value was derived (derive.ts), not stored. */
  derived: SpecField[];
  /**
   * The discipline a sail or board belongs to, read from its plan type
   * ("Freeride sails" gives "freeride"); null when the type does not say.
   */
  category: string | null;
  /** Keys this variant lacks that the rules need to place it (keys.ts `placementGaps`). */
  missing: string[];
}

export const SKILLS = ["beginner", "intermediate", "advanced"] as const;
export type Skill = (typeof SKILLS)[number];

export const BOARD_KINDS = ["freeride", "wave"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export type ProfileSource = "form" | "text" | "default" | "invalid";

export interface Profile {
  discipline: "windsurf" | null;
  weightKg: number | null;
  heightCm: number | null;
  skill: Skill | null;
  windMinKn: number | null;
  windMaxKn: number | null;
  budgetEur: number | null;
  owns: RigRole[];
  boardKind: BoardKind | null;
  ownedBoomMinCm: number | null;
  ownedBoomMaxCm: number | null;
  /** Where each field came from; a field the buyer never gave is absent. */
  source: Partial<Record<string, ProfileSource>>;
}

export interface Band {
  min: number;
  max: number;
}

export interface SailRule {
  category: string;
  weightMinKg: number;
  weightMaxKg: number;
  windMinKn: number;
  windMaxKn: number;
  areaM2: Band;
}
export interface BoardRule {
  kind: string;
  skill: string;
  weightMinKg: number;
  weightMaxKg: number;
  volumeL: Band;
}
/** How close two numbers must be to count as the same recommendation. */
export interface Tolerances {
  /** Sail recommended mast length vs mast (plus extension), cm. */
  mastLengthCm: number;
  /** Sail recommended IMCS vs mast IMCS. */
  imcs: number;
}

export interface FinRule {
  /** Boards up to and including this volume. */
  maxVolumeL: number;
  lengthCm: Band;
}

/**
 * The rules table: sail size by weight and wind, board volume by weight and
 * skill, fin length by board volume. Signed off by Recharge staff before
 * launch; `domain/rig/rules.ts` holds a PLACEHOLDER.
 */
export interface RigRules {
  id: string;
  placeholder: boolean;
  sail: readonly SailRule[];
  board: readonly BoardRule[];
  fin: readonly FinRule[];
  /** PLACEHOLDER like the rest of the table until staff set them. */
  tolerances: Tolerances;
  /** Wind assumed when the buyer gave none. */
  defaultWind: Band;
  defaultSkill: Skill;
  defaultBoardKind: BoardKind;
}

export interface RigItem {
  role: RigRole;
  productId: string;
  variantGid: string;
  variantId: number;
  title: string;
  variantTitle: string | null;
  handle: string | null;
  imageUrl: string | null;
  priceMinor: number;
  currency: string;
  available: boolean;
  quantity: number;
  specs: Specs;
  derived: SpecField[];
}

export interface RigAlternative {
  role: RigRole;
  variantGid: string;
  variantId: number;
  productId: string;
  title: string;
  variantTitle: string | null;
  priceMinor: number;
  currency: string;
  specs: Specs;
}

export interface Check {
  id: string;
  ok: boolean;
}

/**
 * A rule that could not run because a part lacks the data it needs. It is
 * neither a pass nor a fail: the rig is verified only for the checks that ran.
 */
export interface Unchecked {
  id: string;
  /** What is missing: the role and the attribute key. */
  missing: Array<{ role: RigRole; key: string }>;
}

export interface Rig {
  label: string;
  items: RigItem[];
  totalMinor: number;
  currency: string;
  checks: Check[];
  unchecked: Unchecked[];
  alternatives: RigAlternative[];
}

export interface Unmet {
  role: RigRole | "budget" | "profile";
  reason: string;
  /** For the budget: how much over, in minor units. */
  overMinor?: number;
}

export interface EngineWarning {
  code: string;
  /** Machine-readable detail for the theme's sentence. */
  detail?: Record<string, string | number>;
}

export interface BuildResult {
  /** Fields still needed before a rig can be built. */
  needs: string[];
  rigs: Rig[];
  checks: Check[];
  unchecked: Unchecked[];
  unmet: Unmet[];
  warnings: EngineWarning[];
  /** Variants left out for lacking an attribute, by key (feeds readiness). */
  missingAttributes: Record<string, number>;
  /** Variants considered after stock and shop filters, by role. */
  considered: Partial<Record<RigRole, number>>;
}
