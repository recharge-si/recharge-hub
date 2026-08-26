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
 *
 * ## Seen once is not seen now
 *
 * `observedAt` is the last *sighting*, and a sighting does not expire on its
 * own: a merchant who deletes a pricelist in MetaKocka leaves a row here that
 * still carries the day it was last priced. The register therefore also needs
 * to know when it was last *read* — `shop.pricelistsReadAt` — because only the
 * two together say whether a code is still there. A row whose sighting predates
 * the newest read is one the newest read looked for and did not find.
 *
 * That distinction is the whole difference between a picker that offers a
 * pricelist which no longer exists and one that stops offering it.
 */

export interface RegisteredPricelist {
  code: string;
  title: string | null;
  includesTax: boolean | null;
  /** Null when no priced product uses this code. Not a rejection. */
  observedAt: Date | null;
  /**
   * Whether the most recent read found this code.
   *
   * False for a code the merchant typed that has never been seen, and for one
   * that was seen before and has since been deleted in MetaKocka. The screen
   * tells those two apart by whether `observedAt` is null.
   */
  seen: boolean;
}

export interface PricelistRegister {
  entries: RegisteredPricelist[];
  /** When a read last ran, whatever it found. Null before the first one. */
  readAt: Date | null;
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

/**
 * The register, and what the newest read made of it.
 *
 * Read in one go rather than as two calls, because `seen` is a comparison
 * between the two and computing it anywhere else would let a caller forget.
 */
export async function getPricelistRegister(
  principal: Principal,
): Promise<PricelistRegister> {
  const domain = shopDomainOf(principal);

  const [shop, rows] = await Promise.all([
    prisma.shop.findUnique({
      where: { domain },
      select: { pricelistsReadAt: true },
    }),
    prisma.metakockaPricelist.findMany({
      where: { shop: { domain } },
      orderBy: { code: "asc" },
      select: {
        code: true,
        title: true,
        includesTax: true,
        observedAt: true,
      },
    }),
  ]);

  const readAt = shop?.pricelistsReadAt ?? null;

  return {
    readAt,
    entries: rows.map((row) => ({
      ...row,
      // A register filled before this timestamp existed has no read to compare
      // against, so a sighting is taken at face value rather than retracted.
      seen:
        row.observedAt !== null &&
        (readAt === null || row.observedAt.getTime() >= readAt.getTime()),
    })),
  };
}

export async function listTaxRates(principal: Principal): Promise<string[]> {
  const rows = await prisma.metakockaTaxRate.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { percent: true },
  });

  return rows.map((row) => row.percent).sort((a, b) => Number(a) - Number(b));
}

/**
 * Records what a catalogue read saw, and that it ran.
 *
 * Rows are never deleted here. A pricelist whose last priced product was
 * removed stops being observed, and the settings screen may still be pointing
 * at it — dropping it would make a configured setting look unconfigured, which
 * is the same mistake the profit centre register avoids by keeping rejected
 * entries. `observedAt` carries the age instead.
 *
 * The read is stamped on the shop whether or not it found anything, which is
 * what makes an empty result mean something. Without it a merchant who deleted
 * every pricelist in MetaKocka saw a picker still offering them and a caption
 * still claiming a recent read: nothing had been written, so nothing had
 * changed on screen either.
 */
export async function recordObservation(
  principal: Principal,
  observation: CatalogueObservation,
): Promise<{ pricelists: number; taxRates: number }> {
  const shopId = await shopIdFor(principal);
  const now = new Date();

  await prisma.shop.update({
    where: { id: shopId },
    data: { pricelistsReadAt: now },
  });

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
 * Stored unobserved so the screen can go on saying it is unconfirmed rather
 * than quietly forgetting it and presenting an empty field on the next visit.
 * It is not a pricelist we know exists, so it is never offered as a choice —
 * only kept, and shown back as the code that is configured.
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
