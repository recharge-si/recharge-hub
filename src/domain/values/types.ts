import type { MetafieldMap } from "~/domain/sales/types";

/**
 * The catalogue as bulk values see it (docs/attributes.md § Bulk values):
 * one product with its variants, read from the catalogue snapshot, and the
 * type a person chose for it. Pure data; the adapters fill it.
 */
export interface ValuesVariant {
  variantId: string;
  sku: string | null;
  title: string;
  /** The variant's option values, Shopify's placeholder left out. */
  options: string[];
  metafields: MetafieldMap;
}

export interface ValuesProduct {
  productId: string;
  title: string;
  vendor: string;
  productType: string | null;
  categoryName: string | null;
  /** The type a person chose on the product page, if any. */
  chosenTypeId: string | null;
  metafields: MetafieldMap;
  variants: ValuesVariant[];
}

/** The limits of a file and of a download (docs/attributes.md § Bulk values). */
export const LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  importRows: 5_000,
  exportRows: 10_000,
  /** Cells that change something, across the whole file. */
  changes: 25_000,
  errorsShown: 50,
  sampleShown: 50,
  previewHours: 24,
} as const;
