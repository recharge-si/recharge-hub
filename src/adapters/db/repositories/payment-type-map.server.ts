import type { PaymentTypeMap } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * Shopify payment gateway to MetaKocka payment type (CLAUDE.md §6, §8.7).
 *
 * No MetaKocka endpoint lists the accepted `payment_type` strings, so this table
 * is merchant-entered and an unmapped gateway raises an exception rather than
 * being guessed. Gift cards and store credit map through the same table.
 */
export type { PaymentTypeMap };

export async function listPaymentTypeMaps(
  principal: Principal,
): Promise<PaymentTypeMap[]> {
  return prisma.paymentTypeMap.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { shopifyGateway: "asc" },
  });
}

/** Returns null when the gateway is unmapped: the caller must raise, not guess. */
export async function findPaymentType(
  principal: Principal,
  shopifyGateway: string,
): Promise<string | null> {
  const row = await prisma.paymentTypeMap.findFirst({
    where: {
      shopifyGateway,
      shop: { domain: shopDomainOf(principal) },
    },
  });

  return row?.metakockaPaymentType ?? null;
}

export interface PaymentMappingInput {
  shopifyGateway: string;
  metakockaPaymentType: string;
}

/** Replaces the whole set, which is how the settings form submits it. */
export async function replacePaymentTypeMaps(
  principal: Principal,
  mappings: PaymentMappingInput[],
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  await prisma.$transaction([
    prisma.paymentTypeMap.deleteMany({ where: { shopId: shop.id } }),
    ...mappings.map((mapping) =>
      prisma.paymentTypeMap.create({
        data: { shopId: shop.id, ...mapping },
      }),
    ),
  ]);
}
