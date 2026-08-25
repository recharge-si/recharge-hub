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

/* -------------------------------------------------------------------------- */
/* Payment types discovered from MetaKocka                                    */
/* -------------------------------------------------------------------------- */

export interface CachedPaymentType {
  value: string;
  syncedAt: Date;
}

export async function listCachedPaymentTypes(
  principal: Principal,
): Promise<CachedPaymentType[]> {
  const rows = await prisma.metakockaPaymentType.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: { value: "asc" },
  });

  return rows.map((row) => ({ value: row.value, syncedAt: row.syncedAt }));
}

/** Replaces the cached set with what MetaKocka just reported. */
export async function replaceCachedPaymentTypes(
  principal: Principal,
  values: string[],
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  const now = new Date();

  await prisma.$transaction([
    prisma.metakockaPaymentType.deleteMany({
      where: { shopId: shop.id, value: { notIn: values } },
    }),
    ...values.map((value) =>
      prisma.metakockaPaymentType.upsert({
        where: { shopId_value: { shopId: shop.id, value } },
        create: { shopId: shop.id, value, syncedAt: now },
        update: { syncedAt: now },
      }),
    ),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Shop-level payment settings                                                */
/* -------------------------------------------------------------------------- */

/**
 * The payment type used when a gateway has no mapping of its own.
 *
 * §8.7 says never to guess a payment type, and this does not guess: it is a
 * value the merchant chose, and the settings screen refuses to save without it.
 * Before it existed, an order on an unmapped gateway was simply created unpaid
 * with an exception attached, which is safe but leaves the books waiting on
 * somebody every time a new gateway appears.
 */
export async function getFallbackPaymentType(
  principal: Principal,
): Promise<string | null> {
  const row = await prisma.paymentSetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { fallbackPaymentType: true },
  });
  return row?.fallbackPaymentType ?? null;
}

export async function saveFallbackPaymentType(
  principal: Principal,
  value: string | null,
): Promise<void> {
  const domain = shopDomainOf(principal);
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  if (!shop) throw new Error(`No shop record for ${domain}`);

  await prisma.paymentSetting.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, fallbackPaymentType: value },
    update: { fallbackPaymentType: value },
  });
}
