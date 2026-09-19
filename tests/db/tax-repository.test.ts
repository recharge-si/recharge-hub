import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  freezeTaxSnapshot,
  getTaxConfig,
  getTaxSettings,
  getTaxSnapshot,
  recordRefundBreakdowns,
  replaceTaxMappings,
  saveTaxDecision,
  saveTaxSettings,
} from "~/adapters/db/repositories/tax.server";
import { decideOrderTax } from "~/domain/tax/decide";
import type { RefundTaxBreakdown } from "~/domain/tax/refunds";
import type { NormalizedOrderTax } from "~/domain/tax/types";

import {
  createOrder,
  createTenant,
  describeDatabase,
  destroyTenant,
  prisma,
  type TestTenant,
} from "./harness";

/**
 * The tax tables, against a real database: a decision is recorded and read
 * back whole, the lines carry what was decided, the configuration version
 * moves when the configuration does, and the migration's backfill turns the
 * old global setting into the new tables the way its comment promises.
 */
describeDatabase("tax configuration and decisions", () => {
  let tenant: TestTenant | null = null;

  afterEach(async () => {
    if (tenant) await destroyTenant(tenant);
    tenant = null;
  });

  it("starts from safe defaults and bumps the version on every change", async () => {
    tenant = await createTenant("tax-defaults");

    const before = await getTaxSettings(tenant.principal);
    expect(before).toMatchObject({
      domesticCountry: "SI",
      domesticRateKey: null,
      fallbackScope: "domestic",
      nonEuNoTaxPolicy: "review",
      ossEnabled: false,
      configVersion: 1,
    });

    await saveTaxSettings(tenant.principal, {
      domesticCountry: "SI",
      domesticRateKey: "22",
      fallbackScope: "eu",
      nonEuNoTaxPolicy: "export",
      ossEnabled: false,
    });
    await replaceTaxMappings(tenant.principal, [
      { rateKey: "0", metakockaTaxFactor: "0", enabled: true },
      { rateKey: "22", metakockaTaxFactor: "0.22", enabled: true },
    ]);

    const config = await getTaxConfig(tenant.principal);
    expect(config.version).toBe(3);
    expect(config.domesticRateKey).toBe("22");
    expect(config.mappings).toHaveLength(2);
    // The reference table is present without anyone seeding it.
    expect(
      config.countryRates.some(
        (row) => row.country === "AT" && row.rateKey === "20",
      ),
    ).toBe(true);
  });

  it("records a decision, materialises it onto the lines, and freezes it once written", async () => {
    tenant = await createTenant("tax-decision");
    const orderId = await createOrder(tenant);
    const line = await prisma.orderLine.findFirstOrThrow({
      where: { orderId },
    });

    await replaceTaxMappings(tenant.principal, [
      { rateKey: "22", metakockaTaxFactor: "0.22", enabled: true },
    ]);
    const config = await getTaxConfig(tenant.principal);

    const normalized: NormalizedOrderTax = {
      currency: "EUR",
      taxesIncluded: true,
      totalTaxMinor: 3769,
      orderTaxLines: [],
      destinationCountry: "SI",
      billingCountry: "SI",
      customer: { isBusiness: false, vatNumber: null, taxExempt: false },
      lines: [
        {
          lineId: line.shopifyLineItemId,
          sku: "SKU-A",
          quantity: 2,
          unitPriceMinor: 10_450,
          discountMinor: 0,
          taxable: true,
          taxLines: [{ rateKey: "22", amountMinor: 3769, title: null }],
        },
      ],
      shipping: null,
    };
    const decision = decideOrderTax(normalized, config);
    expect(decision.ok).toBe(true);

    const now = new Date();
    await saveTaxDecision(tenant.principal, { orderId, decision, config, now });

    const stored = await getTaxSnapshot(tenant.principal, orderId);
    expect(stored?.decision).toEqual(decision);
    expect(stored?.config.version).toBe(config.version);
    expect(stored?.frozenAt).toBeNull();

    const materialised = await prisma.orderLine.findFirstOrThrow({
      where: { id: line.id },
    });
    expect(materialised).toMatchObject({
      taxFactor: "0.22",
      taxRateKey: "22",
      taxTreatment: "DOMESTIC_VAT",
      taxSource: "SHOPIFY",
      taxableMinor: 20_900 - 3769,
      taxMinor: 3769,
    });

    await freezeTaxSnapshot(tenant.principal, orderId, now);
    expect((await getTaxSnapshot(tenant.principal, orderId))?.frozenAt).toEqual(
      now,
    );

    // Another tenant cannot read it.
    const other = await createTenant("tax-other");
    try {
      expect(await getTaxSnapshot(other.principal, orderId)).toBeNull();
    } finally {
      await destroyTenant(other);
    }
  });

  it("keeps one breakdown per refund however often the order is re-read", async () => {
    tenant = await createTenant("tax-refunds");
    const orderId = await createOrder(tenant);
    const config = await getTaxConfig(tenant.principal);
    const decision = decideOrderTax(
      {
        currency: "EUR",
        taxesIncluded: true,
        totalTaxMinor: 0,
        orderTaxLines: [],
        destinationCountry: "SI",
        billingCountry: "SI",
        customer: { isBusiness: false, vatNumber: null, taxExempt: true },
        lines: [],
        shipping: null,
      },
      config,
    );
    await saveTaxDecision(tenant.principal, {
      orderId,
      decision,
      config,
      now: new Date(),
    });

    const breakdown: RefundTaxBreakdown = {
      refundId: "R1",
      createdAt: null,
      configVersion: config.version,
      currency: "EUR",
      entries: [],
      shipping: null,
      totals: [],
      totalTaxableMinor: 0,
      totalTaxMinor: 0,
      unmatchedLineIds: [],
    };
    await recordRefundBreakdowns(tenant.principal, orderId, [breakdown]);
    await recordRefundBreakdowns(tenant.principal, orderId, [
      breakdown,
      { ...breakdown, refundId: "R2" },
    ]);

    const stored = await getTaxSnapshot(tenant.principal, orderId);
    expect(stored?.refunds.map((entry) => entry.refundId)).toEqual([
      "R1",
      "R2",
    ]);
  });

  it("migrates the old global tax setting without loss and seeds the rates already sent", async () => {
    tenant = await createTenant("tax-migration");

    await prisma.productSyncSetting.create({
      data: { shopId: tenant.shopId, taxPercent: "9,50" },
    });
    const orderId = await createOrder(tenant);
    await prisma.orderLine.updateMany({
      where: { orderId },
      data: { taxFactor: "0.22" },
    });
    await prisma.metakockaTaxRate.create({
      data: { shopId: tenant.shopId, percent: "5" },
    });

    /*
     * The backfill section of the migration, replayed. Every statement is
     * `ON CONFLICT DO NOTHING` or a guarded UPDATE, so running it again over
     * the shops that already went through it changes nothing for them and
     * does for this one exactly what it did for them.
     */
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260919010000_taxes_and_vat/migration.sql",
      ),
      "utf8",
    );
    const marker = "-- Migrate the existing global tax setting";
    /*
     * Scoped to this tenant. The migration itself runs over every shop, and
     * so would this replay — while the other database tests are creating and
     * deleting tenants of their own alongside it, which is a foreign-key race
     * this test has no business entering.
     */
    const scoped = (text: string, from: string, to: string): string => {
      if (!text.includes(from))
        throw new Error(`migration no longer contains: ${from}`);
      return text.replace(from, to);
    };
    let backfill = sql.slice(sql.indexOf(marker));
    backfill = scoped(
      backfill,
      `WHERE p."tax_percent" IS NOT NULL`,
      `WHERE p."shop_id" = '${tenant.shopId}' AND p."tax_percent" IS NOT NULL`,
    );
    backfill = scoped(
      backfill,
      `FROM "shop" s\n`,
      `FROM "shop" s WHERE s."id" = '${tenant.shopId}'\n`,
    );
    backfill = scoped(
      backfill,
      `WHERE t."domestic_rate_key" IS NOT NULL`,
      `WHERE t."shop_id" = '${tenant.shopId}' AND t."domestic_rate_key" IS NOT NULL`,
    );
    backfill = scoped(
      backfill,
      `WHERE l."tax_factor" IS NOT NULL`,
      `WHERE o."shop_id" = '${tenant.shopId}' AND l."tax_factor" IS NOT NULL`,
    );
    backfill = scoped(
      backfill,
      `WHERE trim(r."percent")`,
      `WHERE r."shop_id" = '${tenant.shopId}' AND trim(r."percent")`,
    );
    backfill = scoped(
      backfill,
      `WHERE o2."raw_payload" IS NOT NULL`,
      `WHERE o2."shop_id" = '${tenant.shopId}' AND o2."raw_payload" IS NOT NULL`,
    );

    for (const statement of backfill
      .split(/;\s*\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.replace(/--.*$/gm, "").trim() !== "")) {
      await prisma.$executeRawUnsafe(statement);
    }

    const settings = await getTaxSettings(tenant.principal);
    expect(settings).toMatchObject({
      domesticCountry: "SI",
      domesticRateKey: "9.5",
      // What the write job used to do: the configured rate stood in on every
      // EU order. Outside the EU it now waits rather than filing home VAT.
      fallbackScope: "eu",
      nonEuNoTaxPolicy: "review",
      // Never inferred.
      ossEnabled: false,
    });

    const config = await getTaxConfig(tenant.principal);
    expect(
      config.mappings
        .map((row) => [row.rateKey, row.metakockaTaxFactor])
        .sort(),
    ).toEqual([
      ["0", "0"],
      ["22", "0.22"],
      ["5", "0.05"],
      ["9.5", "0.095"],
    ]);
    expect(config.registrations).toEqual([]);
  });
});
