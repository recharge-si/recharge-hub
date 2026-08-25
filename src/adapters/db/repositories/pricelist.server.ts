import { prisma } from "~/adapters/db/client.server";
import type { CatalogueObservation } from "~/adapters/metakocka/pricelists";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The pricelist register, and the VAT rates seen beside it.
 *
 * Neither can be listed by MetaKocka (CLAUDE.md §3), so both are filled from a
 * read-only pass over the catalogue: a pricelist that has a price on a product
 * is visible, and its `tax_desc` gives a rate the company actually uses.
 *
 * A code the read has never seen is kept with `observedAt` null rather than
 * refused. A pricelist with nothing priced on it is invisible to that pass, and
 * a merchant pointing at a brand new one is doing something legitimate. The
 * screen says the code could not be confirmed; it does not block on it.
 */

export interface RegisteredPricelist {
  code: string;
  title: string | null;
  includesTax: boolean | null;
  /** Null when no priced product uses this code. Not a rejection. */
  observedAt: Date | null;
}

async function shopIdFor(principal: Principal): Promise<string> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);
  return shop.id;
}

export async function listPricelists(
  principal: Principal,
): Promise<RegisteredPricelist[]> {
  return prisma.metakockaPricelist.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { code: "asc" },
    select: {
      code: true,
      title: true,
      includesTax: true,
      observedAt: true,
    },
  });
}

export async function listTaxRates(principal: Principal): Promise<string[]> {
  const rows = await prisma.metakockaTaxRate.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { percent: true },
  });

  return rows.map((row) => row.percent).sort((a, b) => Number(a) - Number(b));
}

/**
 * Records what a catalogue read saw.
 *
 * Rows are never deleted here. A pricelist whose last priced product was
 * removed stops being observed, and the settings screen may still be pointing
 * at it — dropping it would make a configured setting look unconfigured, which
 * is the same mistake the profit centre register avoids by keeping rejected
 * entries. `observedAt` carries the age instead.
 */
export async function recordObservation(
  principal: Principal,
  observation: CatalogueObservation,
): Promise<{ pricelists: number; taxRates: number }> {
  const shopId = await shopIdFor(principal);
  const now = new Date();

  for (const pricelist of observation.pricelists) {
    const data = {
      title: pricelist.title,
      includesTax: pricelist.includesTax,
      observedAt: now,
    };
    await prisma.metakockaPricelist.upsert({
      where: { shopId_code: { shopId, code: pricelist.code } },
      create: { shopId, code: pricelist.code, ...data },
      update: data,
    });
  }

  for (const percent of observation.taxPercents) {
    await prisma.metakockaTaxRate.upsert({
      where: { shopId_percent: { shopId, percent } },
      create: { shopId, percent, observedAt: now },
      update: { observedAt: now },
    });
  }

  return {
    pricelists: observation.pricelists.length,
    taxRates: observation.taxPercents.length,
  };
}

/**
 * Keeps a code the merchant typed that the catalogue read has not seen.
 *
 * Stored unobserved so the picker can offer it back, and so the screen can go
 * on saying it is unconfirmed rather than quietly forgetting it and presenting
 * an empty field on the next visit.
 */
export async function rememberPricelistCode(
  principal: Principal,
  code: string,
): Promise<void> {
  const trimmed = code.trim();
  if (!trimmed) return;
  const shopId = await shopIdFor(principal);

  await prisma.metakockaPricelist.upsert({
    where: { shopId_code: { shopId, code: trimmed } },
    create: { shopId, code: trimmed },
    update: {},
  });
}
