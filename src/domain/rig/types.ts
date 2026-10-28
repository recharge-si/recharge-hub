import type { RigRole, SpecField } from "~/domain/rig/keys";

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
  /** Units, when the snapshot knows them. */
  inventoryQuantity: number | null;
  /** Numbers and codes read off the metafields, by field. */
  specs: Partial<Record<SpecField, number | string>>;
  /** Required keys this variant has no usable value for. */
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
  specs: Partial<Record<SpecField, number | string>>;
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
}

export interface Check {
  id: string;
  ok: boolean;
}

export interface Rig {
  label: string;
  items: RigItem[];
  totalMinor: number;
  currency: string;
  checks: Check[];
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
  unmet: Unmet[];
  warnings: EngineWarning[];
  /** Variants left out for lacking an attribute, by key (feeds readiness). */
  missingAttributes: Record<string, number>;
  /** Variants considered after stock and shop filters, by role. */
  considered: Partial<Record<RigRole, number>>;
}
