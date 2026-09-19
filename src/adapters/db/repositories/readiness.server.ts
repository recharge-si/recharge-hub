import { prisma } from "~/adapters/db/client.server";
import { getTaxDiagnosticsFacts } from "~/adapters/db/repositories/tax.server";
import { computeReadiness, type Readiness } from "~/domain/readiness";
import { computeTaxDiagnostics } from "~/domain/tax/diagnostics";
import { countryName } from "~/domain/tax/eu";
import { formatRateKey } from "~/domain/tax/rates";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The facts behind `domain/readiness`, read from our own database.
 *
 * Nothing here touches MetaKocka or Shopify. Readiness is shown on the home
 * page, on every settings page and in guided setup, so it has to be cheap
 * enough to compute on any render (docs/BUILD_SPEC.md section 2.5) — one
 * parallel batch of small indexed queries, no live integration call, no query
 * in a loop.
 *
 * The gateways a shop has actually used come from `order.payment_gateway`
 * rather than from Shopify's own orders query, for the same reason: the answer
 * is already in our tables, and Shopify has no endpoint that lists gateway
 * names anyway.
 */
export async function getReadiness(principal: Principal): Promise<Readiness> {
  const domain = shopDomainOf(principal);

  const [
    credential,
    sources,
    defaults,
    paymentMaps,
    paymentSetting,
    salesOrderSetting,
    skuGroups,
    gatewayGroups,
    shop,
    taxFacts,
  ] = await Promise.all([
    prisma.metakockaCredential.findFirst({
      where: { shop: { domain } },
      select: { companyId: true, apiUserEmail: true, lastVerifiedAt: true },
    }),
    prisma.supplySource.findMany({
      where: { shop: { domain } },
      select: {
        name: true,
        enabled: true,
        shopifyLocationId: true,
        metakockaWarehouse: true,
        stockDirection: true,
        lastSyncOk: true,
      },
      orderBy: [{ priority: "asc" }, { code: "asc" }],
    }),
    prisma.supplySetting.findFirst({
      where: { shop: { domain } },
      select: { defaultStockDirection: true },
    }),
    prisma.paymentTypeMap.findMany({
      where: { shop: { domain } },
      select: { shopifyGateway: true },
    }),
    prisma.paymentSetting.findFirst({
      where: { shop: { domain } },
      select: { fallbackPaymentType: true },
    }),
    prisma.salesOrderSetting.findFirst({
      where: { shop: { domain } },
      select: {
        syncPayments: true,
        shippingProductCode: true,
        discountRepresentation: true,
        salesOrderSplit: true,
      },
    }),
    prisma.sku.groupBy({
      by: ["status"],
      where: { shop: { domain } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ["paymentGateway"],
      where: {
        shop: { domain },
        shopifyDeletedAt: null,
        paymentGateway: { not: null },
      },
      _count: { _all: true },
    }),
    prisma.shop.findUnique({
      where: { domain },
      select: { setupCompletedAt: true },
    }),
    getTaxDiagnosticsFacts(principal, new Date(), { includeWarnings: false }),
  ]);

  const taxes = computeTaxDiagnostics(taxFacts);

  const connected = sources.filter(
    (source) =>
      source.shopifyLocationId !== null && source.metakockaWarehouse !== null,
  );

  // A source holding exactly one of the two identifiers is halfway through
  // being set up: it publishes nothing and takes no orders, and saying so is
  // more useful than counting it either way.
  const incompleteNames = sources
    .filter(
      (source) =>
        (source.shopifyLocationId === null) !==
        (source.metakockaWarehouse === null),
    )
    .map((source) => source.name);

  const live = connected.filter((source) => source.enabled);

  const skuCount = (status: string): number =>
    skuGroups.find((group) => group.status === status)?._count._all ?? 0;

  return computeReadiness({
    metakocka: {
      connected: credential !== null,
      verified: credential?.lastVerifiedAt != null,
      companyId: credential?.companyId ?? null,
      apiUserEmail: credential?.apiUserEmail?.trim() || null,
    },
    warehouses: {
      connectedCount: connected.length,
      incompleteNames,
    },
    stock: {
      defaultDirection: defaults?.defaultStockDirection ?? "mk_to_shopify",
      intoShopifyCount: live.filter(
        (source) => source.stockDirection === "mk_to_shopify",
      ).length,
      intoMetakockaCount: live.filter(
        (source) => source.stockDirection === "shopify_to_mk",
      ).length,
      failingNames: live
        .filter(
          (source) =>
            source.stockDirection !== "none" && source.lastSyncOk === false,
        )
        .map((source) => source.name),
    },
    payments: {
      // No row means the defaults, and payment sync is on by default.
      enabled: salesOrderSetting?.syncPayments ?? true,
      seenGateways: gatewayGroups
        .map((group) => group.paymentGateway)
        .filter((gateway): gateway is string => gateway !== null)
        .sort((a, b) => a.localeCompare(b)),
      mappedGateways: paymentMaps.map((row) => row.shopifyGateway),
      fallback: paymentSetting?.fallbackPaymentType?.trim() || null,
    },
    orders: {
      shippingProductCode: salesOrderSetting?.shippingProductCode ?? null,
      discountRepresentation:
        salesOrderSetting?.discountRepresentation ?? "none",
      salesOrderSplit: salesOrderSetting?.salesOrderSplit ?? "per_warehouse",
    },
    products: {
      matched: skuCount("matched"),
      unmatched: skuCount("unmatched"),
    },
    taxes: {
      status: taxes.status,
      domestic: taxFacts.config.domesticRateKey
        ? `${countryName(taxFacts.config.domesticCountry)} ${formatRateKey(taxFacts.config.domesticRateKey)}`
        : null,
      unmappedRates: taxes.unmappedRates,
      blockedOrders: taxes.blockedOrders,
    },
    setupCompletedAt: shop?.setupCompletedAt ?? null,
  });
}
