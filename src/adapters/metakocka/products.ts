import { z } from "zod";

import {
  mkEnvelopeSchema,
  type MetakockaClient,
} from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";

/**
 * `product_add` and `product_update`.
 *
 * Field names come from the MetaKocka docs (`docs/product_add.md`,
 * `docs/product_update.md`) and nothing here is invented (CLAUDE.md §15).
 * Three facts from those docs shape this module:
 *
 *  - `product_update` selects the record by `count_code` or `mk_id`, and an
 *    empty or null value leaves the current value alone. Only fields we mean to
 *    change are ever sent.
 *  - `product_add` fails when a product with the same `count_code` and `code`
 *    already exists, so creating is only attempted for a SKU the registry says
 *    MetaKocka does not have.
 *  - a price lives inside `pricelist[].price_def[]` under a pricelist
 *    `count_code` that must already exist in MetaKocka. The API cannot create
 *    one (§3), so the merchant names theirs in settings.
 *
 * There is no bulk endpoint: one product per call, sequentially, from a
 * background job (§8.9).
 */

const productResponseSchema = mkEnvelopeSchema.and(
  z.object({
    mk_id: z.union([z.string(), z.number()]).transform(String).optional(),
    count_code: z.string().optional(),
  }),
);

export interface PriceInput {
  /** Pricelist `count_code`, exactly as it exists in MetaKocka. */
  pricelistCode: string;
  /** Decimal string, already restated on the pricelist's own basis. */
  price: string;
  /**
   * Whether the figure above includes tax — a property of **the pricelist**,
   * not of the Shopify shop.
   *
   * **[verified]** A MetaKocka pricelist has its own net-or-gross type, fixed
   * when it was created. Pricelist "1" on company 6789 is net, and sending
   * `price_with_tax` to it is refused outright:
   *
   * > Pricelist '1' has 'net' price type. Use 'price' instead of
   * > 'price_with_tax' to set the product price on the pricelist.
   *
   * The caller converts the amount to match; this only decides the field name.
   * Getting the pair wrong is not a format error, it is a price wrong by the
   * VAT rate that MetaKocka stores without complaint.
   */
  taxIncluded: boolean;
  /** Decimal factor such as "0.22", or null to leave tax to MetaKocka. */
  taxFactor: string | null;
}

/**
 * What kind of article MetaKocka holds — Prodajni, Nabavni, Storitev.
 *
 * These three are the only type flags `product_add` and `product_update`
 * accept (`docs/product_concept.md`). The MetaKocka product screen shows two
 * more, Delo and Osnovno sredstvo: `work` exists only as a `product_list`
 * filter and fixed asset appears nowhere in the API, so neither can be set
 * from here and neither is invented (§15).
 *
 * Left unset, MetaKocka defaults all three to false, and an article that is
 * not `sales` cannot go on a sales order at all.
 */
export interface ProductTypeFlags {
  sales: boolean;
  purchasing: boolean;
  service: boolean;
}

/** What this app sent before the flags were settable. */
export const DEFAULT_PRODUCT_TYPE: ProductTypeFlags = {
  sales: true,
  purchasing: false,
  service: false,
};

function typeBody(flags: ProductTypeFlags) {
  return {
    sales: String(flags.sales),
    purchasing: String(flags.purchasing),
    service: String(flags.service),
  };
}

export interface ProductInput {
  /** The external reference. This app uses the Shopify SKU for both. */
  countCode: string;
  code: string;
  name: string;
  barcode?: string | null;
  unit?: string;
  price?: PriceInput | null;
  /** Defaults to a sales-only article, which is what this app always sent. */
  type?: ProductTypeFlags;
}

export interface ProductWriteResult {
  mkId: string | null;
  countCode: string | null;
}

function pricelistBody(price: PriceInput) {
  return [
    {
      count_code: price.pricelistCode,
      price_def: [
        {
          amount_from: "0",
          amount_to: null,
          // The field the pricelist's own type demands. See PriceInput.
          ...(price.taxIncluded
            ? { price_with_tax: price.price }
            : { price: price.price }),
          ...(price.taxFactor ? { tax_factor: price.taxFactor } : {}),
        },
      ],
    },
  ];
}

/**
 * Creates a product. The type flags are the merchant's (see ProductTypeFlags);
 * everything else about the article stays MetaKocka's (§8.9).
 */
export async function addProduct(
  client: MetakockaClient,
  input: ProductInput,
): Promise<ProductWriteResult> {
  const response = await client.call(
    ENDPOINTS.productAdd,
    {
      count_code: input.countCode,
      code: input.code,
      name: input.name,
      unit: input.unit ?? "kos",
      ...typeBody(input.type ?? DEFAULT_PRODUCT_TYPE),
      ...(input.barcode ? { barcode: input.barcode } : {}),
      ...(input.price ? { pricelist: pricelistBody(input.price) } : {}),
    },
    productResponseSchema,
  );

  return {
    mkId: response.mk_id ?? null,
    countCode: response.count_code ?? null,
  };
}

export interface ProductUpdateInput {
  /** Either identifier selects the record; `mk_id` is used when we have it. */
  mkId?: string | null;
  countCode?: string | null;
  name?: string;
  barcode?: string | null;
  price?: PriceInput | null;
  /**
   * Sent only when the merchant asked for it, and only when the article's
   * flags actually differ — MetaKocka warns and asks for
   * `confirm_save_change_product_service` when the service flag changes on an
   * article already used on a document, and that confirmation recalculates
   * stock. This app never sends it: the rejection is reported to the merchant
   * instead of silently agreeing to a recalculation on their books.
   */
  type?: ProductTypeFlags | null;
}

/**
 * Updates an existing product. Only the fields passed are sent: MetaKocka
 * leaves anything absent untouched, and this app has no business rewriting
 * fields the ERP owns (§8.9).
 */
export async function updateProduct(
  client: MetakockaClient,
  input: ProductUpdateInput,
): Promise<ProductWriteResult> {
  if (!input.mkId && !input.countCode) {
    throw new Error(
      "updateProduct needs mk_id or count_code to select a record",
    );
  }

  const response = await client.call(
    ENDPOINTS.productUpdate,
    {
      ...(input.mkId ? { mk_id: input.mkId } : {}),
      ...(input.countCode ? { count_code: input.countCode } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.barcode ? { barcode: input.barcode } : {}),
      ...(input.type ? typeBody(input.type) : {}),
      ...(input.price ? { pricelist: pricelistBody(input.price) } : {}),
    },
    productResponseSchema,
  );

  return {
    mkId: response.mk_id ?? null,
    countCode: response.count_code ?? null,
  };
}

/**
 * A percentage a merchant typed ("22", "9,5") as the decimal factor MetaKocka
 * wants ("0.22"). Returns null for anything that is not a number, so a typo
 * leaves tax to the ERP rather than sending a wrong rate.
 */
export function taxFactorFromPercent(percent: string | null): string | null {
  if (!percent) return null;

  const normalised = percent.trim().replace(",", ".").replace("%", "");
  const value = Number(normalised);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;

  return (value / 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}
