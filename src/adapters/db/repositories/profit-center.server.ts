import { prisma } from "~/adapters/db/client.server";
import type { ProfitCenterVerdict } from "~/adapters/metakocka/profit-centers";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The profit centre register (CLAUDE.md §7).
 *
 * MetaKocka has no endpoint that lists profit centres and none that validates
 * one (§3), yet a document is refused outright when the name does not match its
 * register exactly. This table is the answer: a merchant-maintained list,
 * checked against the live company as each entry is added
 * (adapters/metakocka/profit-centers.ts), so every screen that needs a profit
 * centre offers a choice instead of a text field and the typo is caught once.
 *
 * Rows are never deleted by a refresh, only marked invalid. A supply source may
 * point at a value MetaKocka has since dropped, and removing it from the list
 * would leave that source looking unconfigured rather than broken.
 */

export interface RegisteredProfitCenter {
  value: string;
  isValid: boolean;
  /** Null when the value has never been checked against MetaKocka. */
  validatedAt: Date | null;
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

export async function listProfitCenters(
  principal: Principal,
): Promise<RegisteredProfitCenter[]> {
  const rows = await prisma.metakockaProfitCenter.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { value: "asc" },
    select: { value: true, isValid: true, validatedAt: true },
  });

  return rows;
}

/**
 * Adds one entry, or updates the verdict on one that is already there.
 *
 * An `unknown` verdict is stored as valid and unvalidated: the check could not
 * be run, which is not the same as a rejection, and refusing the entry would
 * block a merchant on our inability to ask rather than on anything they did.
 */
export async function saveProfitCenter(
  principal: Principal,
  value: string,
  verdict: ProfitCenterVerdict,
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const trimmed = value.trim();
  if (!trimmed) return;

  const data = {
    isValid: verdict !== "invalid",
    validatedAt: verdict === "unknown" ? null : new Date(),
  };

  await prisma.metakockaProfitCenter.upsert({
    where: { shopId_value: { shopId, value: trimmed } },
    create: { shopId, value: trimmed, ...data },
    update: data,
  });
}

/**
 * Supply sources still pointing at a profit centre, by name.
 *
 * The settings screen asks before removing an entry: dropping one out from
 * under a source would leave an order to be rejected by MetaKocka later, a long
 * way from the screen where the decision was made.
 */
export async function sourcesUsingProfitCenter(
  principal: Principal,
  value: string,
): Promise<string[]> {
  const rows = await prisma.supplySource.findMany({
    where: {
      shop: { domain: shopDomainOf(principal) },
      metakockaProfitCenter: value,
    },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  return rows.map((row) => row.name);
}

/** Removes an entry. Callers check `sourcesUsingProfitCenter` first. */
export async function removeProfitCenter(
  principal: Principal,
  value: string,
): Promise<void> {
  await prisma.metakockaProfitCenter.deleteMany({
    where: { shop: { domain: shopDomainOf(principal) }, value },
  });
}

export interface ValidationSummary {
  /** Entries MetaKocka has just confirmed. */
  confirmed: string[];
  /** Entries MetaKocka now rejects. Kept in the register, marked invalid. */
  rejected: string[];
  /** Entries the check could not answer for. Left exactly as they were. */
  unchecked: string[];
}

/** Records the result of a refresh across the whole register. */
export async function recordValidations(
  principal: Principal,
  verdicts: Map<string, ProfitCenterVerdict>,
): Promise<ValidationSummary> {
  const shopId = await shopIdFor(principal);
  const now = new Date();

  const confirmed: string[] = [];
  const rejected: string[] = [];
  const unchecked: string[] = [];

  const writes = [];
  for (const [value, verdict] of verdicts) {
    if (verdict === "unknown") {
      unchecked.push(value);
      continue;
    }

    (verdict === "valid" ? confirmed : rejected).push(value);
    writes.push(
      prisma.metakockaProfitCenter.updateMany({
        where: { shopId, value },
        data: { isValid: verdict === "valid", validatedAt: now },
      }),
    );
  }

  if (writes.length > 0) await prisma.$transaction(writes);

  return { confirmed, rejected, unchecked };
}
