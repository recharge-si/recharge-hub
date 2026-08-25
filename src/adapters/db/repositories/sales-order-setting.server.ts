import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * How this app treats a sales order MetaKocka has already accepted
 * (CLAUDE.md §8.8).
 *
 * There is no row until the merchant saves one, and the defaults are the
 * behaviour: rewrite a document when the Shopify order changes, but stop once a
 * payment has been recorded against it.
 */

export interface SalesOrderSettings {
  /** Rewrite the MetaKocka document when the Shopify order changes. */
  updateOnChange: boolean;
  /** Keep rewriting even after a payment has been recorded against it. */
  updateAfterPaid: boolean;
}

/**
 * On, but not once it is paid.
 *
 * The first is on because the alternative is an ERP holding quantities nobody
 * agreed to, with an exception the merchant can read but not act on. The second
 * is off because a paid document is the one most likely to have been invoiced
 * in MetaKocka, and replacing an invoiced document changes an accounting
 * record — so the highest-stakes case keeps the old, cautious behaviour until
 * the merchant says otherwise.
 */
export const SALES_ORDER_DEFAULTS: SalesOrderSettings = {
  updateOnChange: true,
  updateAfterPaid: false,
};

export async function getSalesOrderSettings(
  principal: Principal,
): Promise<SalesOrderSettings> {
  const row = await prisma.salesOrderSetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { updateOnChange: true, updateAfterPaid: true },
  });

  return row ?? { ...SALES_ORDER_DEFAULTS };
}

export async function saveSalesOrderSettings(
  principal: Principal,
  input: SalesOrderSettings,
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  await prisma.salesOrderSetting.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, ...input },
    update: input,
  });
}
