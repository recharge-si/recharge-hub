/**
 * Sale campaigns: the vocabulary (docs/sale-campaigns.md).
 *
 * Pure types. Money is integer minor units; a percentage is integer basis
 * points (2000 = 20 %). Nothing here reads a clock or talks to Shopify.
 */

export type DiscountType = "percentage" | "fixed_amount" | "fixed_price";

export interface DiscountSpec {
  type: DiscountType;
  /** Basis points for `percentage`; minor units otherwise. */
  value: number;
}

export type RoundingMode =
  | "none"
  | "nearest_whole"
  | "ending_99"
  | "ending_9"
  | "ending_99_99"
  | "increment";

export interface RoundingSpec {
  mode: RoundingMode;
  /** Only read for `increment`. */
  incrementMinor?: number | null;
}

export type ExistingSalePolicy =
  "skip" | "discount_selling_price" | "discount_compare_at" | "override";

export type ConflictStrategy =
  "prevent" | "priority" | "largest_discount" | "newest";

export type BasePriceChangePolicy = "preserve" | "recalculate" | "review";

export type CampaignStatus =
  "draft" | "scheduled" | "active" | "paused" | "completed" | "cancelled";

export type VariantState =
  | "pending"
  | "applying"
  | "applied"
  | "failed"
  | "skipped"
  | "review"
  | "restoring"
  | "restored"
  | "restore_failed"
  | "released";

/** The states in which a campaign owns what Shopify currently shows. */
export const LIVE_STATES: readonly VariantState[] = [
  "applying",
  "applied",
  "review",
  "restoring",
  "restore_failed",
];

/** A variant's price pair as Shopify holds it. */
export interface PricePair {
  priceMinor: number;
  compareAtMinor: number | null;
}

/** Why a variant was not written. Stable codes; copy lives in web/. */
export type SkipReason =
  | "already_on_sale"
  | "would_raise_price"
  | "no_discount"
  | "zero_price"
  | "conflict"
  | "no_longer_matches";

/** One metafield value as the catalogue snapshot stores it. */
export interface MetafieldValue {
  type: string;
  value: string;
}

export type MetafieldMap = Record<string, MetafieldValue>;

/**
 * Everything a targeting rule can read about one variant, joined with its
 * product. This is the shape the catalogue snapshot is read into.
 */
export interface CatalogueVariantFacts {
  variantId: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  variantTitle: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  variantMetafields: MetafieldMap;

  productTitle: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  tags: readonly string[];
  collectionIds: readonly string[];
  categoryId: string | null;
  productMetafields: MetafieldMap;
}
