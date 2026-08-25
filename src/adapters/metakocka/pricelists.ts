import { z } from "zod";

import type { MetakockaClient } from "~/adapters/metakocka/client";
import { ENDPOINTS } from "~/adapters/metakocka/endpoints";

/**
 * Finding out which pricelists a company has, without writing anything.
 *
 * CLAUDE.md §3: MetaKocka will not list pricelists, and it will not create one.
 * The settings screen still has to stop a merchant typing a code that does not
 * exist, because a product price sent to a pricelist that is not there is a
 * rejected call and a price sent to one whose net-or-gross type we guessed
 * wrong is stored silently wrong by the whole VAT rate.
 *
 * ## Why this reads products rather than probing
 *
 * The rejection that names a pricelist's type — "Pricelist '1' has 'net' price
 * type. Use 'price' instead of 'price_with_tax'..." — comes from `product_add`
 * or `product_update`. Turning that into a validation probe would mean sending
 * a catalogue write and relying on MetaKocka checking the pricelist *before*
 * applying it. Nothing documents that ordering. If it were the other way round
 * the probe would create a product, or overwrite a real price, every time it
 * ran. §8.9 makes catalogue writes the one thing this app does only when asked,
 * and `docs/ui-conventions.md` says a preview path never writes, so that probe
 * is not available to us on the evidence we have.
 *
 * `product_list` with `return_pricelist` is read-only and answers the same
 * question from the other side: every pricelist that has a price on it shows up
 * here, with its code, MetaKocka's own title for it, and — from which price
 * field the entry carries — whether it is net or gross.
 *
 * ## What this cannot see
 *
 * A pricelist with no product priced on it is invisible to this read. That is
 * why a code absent from the result is reported as *unseen* rather than as
 * wrong: the merchant may be pointing at a brand new pricelist, and refusing it
 * would block them on our inability to ask. The register carries that
 * distinction the same way the profit centre register carries `unknown`.
 *
 * **[verified]** §3: `product_list` returns no prices at all without
 * `return_pricelist: "true"` — a product with prices looks identical to one
 * without — and the recorded shape of an entry is
 * `{"count_code":"1","price_def":{"tax":"EX4","tax_desc":"22",
 * "price":"171,31"},"title":"Shopify Pricelist"}`.
 */

/** One page of products. The whole catalogue is not needed; see PAGES. */
const PAGE = 100;

/**
 * How many pages to look at.
 *
 * This is a suggestion list, not an inventory. Five hundred products is far
 * more than enough to have seen every pricelist a company actually uses, and
 * reading the entire catalogue to populate a picker would make a settings
 * screen wait on the slowest call in the system.
 */
const PAGES = 5;

/**
 * Permissive on purpose. This shape has been seen in one recorded response and
 * is not in the documentation as a *response*, so every part of it is optional
 * and anything unexpected is ignored rather than failing the read.
 */
const priceDefSchema = z
  .object({
    price: z.string().optional(),
    price_with_tax: z.string().optional(),
    tax: z.string().optional(),
    tax_desc: z.string().optional(),
  })
  .passthrough();

const pricelistEntrySchema = z
  .object({
    count_code: z.string().optional(),
    title: z.string().optional(),
    // Sent as an array on product_add; seen as a bare object on the way back.
    price_def: z
      .union([priceDefSchema, z.array(priceDefSchema)])
      .optional()
      .transform((value) =>
        value === undefined ? [] : Array.isArray(value) ? value : [value],
      ),
  })
  .passthrough();

const responseSchema = z
  .object({
    product_list: z
      .array(
        z
          .object({ pricelist: z.array(pricelistEntrySchema).optional() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface ObservedPricelist {
  /** The `count_code` a product's price is filed under. */
  code: string;
  /** MetaKocka's own name for it, when it gave one. */
  title: string | null;
  /**
   * True when prices on it include tax, false when they exclude it, null when
   * the entries seen did not say. Read from which field carries the amount,
   * which is the same thing the rejection would have told us.
   */
  includesTax: boolean | null;
}

export interface CatalogueObservation {
  pricelists: ObservedPricelist[];
  /** VAT rates seen on priced products, as percentages: "22", "9.5". */
  taxPercents: string[];
}

function normalisePercent(raw: string): string | null {
  const value = raw.trim().replace(",", ".").replace("%", "");
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  // "22.00" and "22" are the same rate and must not become two suggestions.
  return String(parsed);
}

/**
 * Reads what the catalogue says about pricelists and tax rates. Writes nothing.
 */
export async function observeCatalogue(
  client: MetakockaClient,
): Promise<CatalogueObservation> {
  const byCode = new Map<string, ObservedPricelist>();
  const percents = new Set<string>();

  for (let page = 0; page < PAGES; page += 1) {
    const response = await client.call(
      ENDPOINTS.productList,
      // Without this the response carries no pricelist at all, which looks
      // exactly like a catalogue with no prices (§3, verified).
      { limit: PAGE, offset: page * PAGE, return_pricelist: "true" },
      responseSchema,
    );

    for (const product of response.product_list) {
      for (const entry of product.pricelist ?? []) {
        const code = entry.count_code?.trim();
        if (!code) continue;

        const existing = byCode.get(code);
        const net = entry.price_def.some((def) => def.price !== undefined);
        const gross = entry.price_def.some(
          (def) => def.price_with_tax !== undefined,
        );

        byCode.set(code, {
          code,
          title: entry.title?.trim() || (existing?.title ?? null),
          // Only decide when the entries agree. A pricelist reporting both
          // fields is telling us something we do not understand, and the sync
          // already corrects itself from MetaKocka's own rejection.
          includesTax:
            net && !gross
              ? false
              : gross && !net
                ? true
                : (existing?.includesTax ?? null),
        });

        for (const def of entry.price_def) {
          const percent = def.tax_desc ? normalisePercent(def.tax_desc) : null;
          if (percent !== null) percents.add(percent);
        }
      }
    }

    if (response.product_list.length < PAGE) break;
  }

  return {
    pricelists: [...byCode.values()].sort((a, b) =>
      a.code.localeCompare(b.code),
    ),
    taxPercents: [...percents].sort((a, b) => Number(a) - Number(b)),
  };
}
