import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { effectiveCountryRates } from "~/domain/tax/config";
import type { TaxDiagnosticsFacts } from "~/domain/tax/diagnostics";
import type { RefundTaxBreakdown } from "~/domain/tax/refunds";
import {
  TAX_ISSUE_KINDS,
  TAX_SOURCES,
  TAX_TREATMENTS,
  type CountryRateConfig,
  type NonEuNoTaxPolicy,
  type TaxConfig,
  type TaxDecision,
  type TaxFallbackScope,
  type TaxMappingConfig,
  type TaxIssueKind,
  type TaxOverrideConfig,
  type VatRegistrationConfig,
} from "~/domain/tax/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The tax configuration and each order's tax decision, from the database.
 *
 * Every read here is tenant-scoped through the shop domain of the principal,
 * and every write to the configuration bumps `tax_setting.config_version` so a
 * decision can say which version it was made under.
 */

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export interface TaxSettings {
  domesticCountry: string;
  domesticRateKey: string | null;
  fallbackScope: TaxFallbackScope;
  nonEuNoTaxPolicy: NonEuNoTaxPolicy;
  ossEnabled: boolean;
  configVersion: number;
}

const DEFAULT_SETTINGS: TaxSettings = {
  domesticCountry: "SI",
  domesticRateKey: null,
  fallbackScope: "domestic",
  nonEuNoTaxPolicy: "review",
  ossEnabled: false,
  configVersion: 1,
};

export async function getTaxSettings(
  principal: Principal,
): Promise<TaxSettings> {
  const row = await prisma.taxSetting.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  if (!row) return DEFAULT_SETTINGS;
  return {
    domesticCountry: row.domesticCountry,
    domesticRateKey: row.domesticRateKey,
    fallbackScope: row.fallbackScope,
    nonEuNoTaxPolicy: row.nonEuNoTaxPolicy,
    ossEnabled: row.ossEnabled,
    configVersion: row.configVersion,
  };
}

/** Ensures the settings row exists and bumps its version, inside `tx`. */
async function bumpVersion(
  tx: Prisma.TransactionClient,
  shopId: string,
  data: Partial<Omit<TaxSettings, "configVersion">> = {},
): Promise<number> {
  const row = await tx.taxSetting.upsert({
    where: { shopId },
    create: { shopId, ...data, configVersion: 2 },
    update: { ...data, configVersion: { increment: 1 } },
    select: { configVersion: true },
  });
  return row.configVersion;
}

export async function saveTaxSettings(
  principal: Principal,
  input: Omit<TaxSettings, "configVersion">,
): Promise<TaxSettings> {
  const shopId = await shopIdFor(principal);
  const version = await prisma.$transaction((tx) =>
    bumpVersion(tx, shopId, input),
  );
  return { ...input, configVersion: version };
}

/* -------------------------------------------------------------------------- */
/* Registrations                                                               */
/* -------------------------------------------------------------------------- */

export async function listVatRegistrations(
  principal: Principal,
): Promise<(VatRegistrationConfig & { id: string; notes: string | null })[]> {
  const rows = await prisma.vatRegistration.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ kind: "asc" }, { country: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    country: row.country,
    vatNumber: row.vatNumber,
    enabled: row.enabled,
    notes: row.notes,
  }));
}

/**
 * Replaces the whole set. A registration is a fact about the merchant, and a
 * list of them is edited as one thing.
 */
export async function replaceVatRegistrations(
  principal: Principal,
  registrations: (VatRegistrationConfig & { notes?: string | null })[],
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(async (tx) => {
    await tx.vatRegistration.deleteMany({ where: { shopId } });
    if (registrations.length > 0) {
      await tx.vatRegistration.createMany({
        data: registrations.map((row) => ({
          shopId,
          kind: row.kind,
          country: row.country.toUpperCase(),
          vatNumber: row.vatNumber?.trim() || null,
          enabled: row.enabled,
          notes: row.notes?.trim() || null,
        })),
      });
    }
    await bumpVersion(tx, shopId);
  });
}

/* -------------------------------------------------------------------------- */
/* Country rates                                                               */
/* -------------------------------------------------------------------------- */

export async function listMerchantCountryRates(
  principal: Principal,
): Promise<CountryRateConfig[]> {
  const rows = await prisma.countryVatRate.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return rows.map((row) => ({
    country: row.country,
    kind: row.kind,
    rateKey: row.rateKey,
    label: row.label,
    origin: "merchant" as const,
  }));
}

export async function upsertCountryRate(
  principal: Principal,
  input: {
    country: string;
    kind: CountryRateConfig["kind"];
    rateKey: string;
    label: string | null;
  },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(async (tx) => {
    await tx.countryVatRate.upsert({
      where: {
        shopId_country_kind: {
          shopId,
          country: input.country.toUpperCase(),
          kind: input.kind,
        },
      },
      create: {
        shopId,
        country: input.country.toUpperCase(),
        kind: input.kind,
        rateKey: input.rateKey,
        label: input.label,
      },
      update: { rateKey: input.rateKey, label: input.label },
    });
    await bumpVersion(tx, shopId);
  });
}

/** Removes the merchant's row, so the reference rate applies again. */
export async function deleteCountryRate(
  principal: Principal,
  input: { country: string; kind: CountryRateConfig["kind"] },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(async (tx) => {
    await tx.countryVatRate.deleteMany({
      where: { shopId, country: input.country.toUpperCase(), kind: input.kind },
    });
    await bumpVersion(tx, shopId);
  });
}

/* -------------------------------------------------------------------------- */
/* Mappings                                                                    */
/* -------------------------------------------------------------------------- */

export async function listTaxMappings(
  principal: Principal,
): Promise<TaxMappingConfig[]> {
  const rows = await prisma.taxMapping.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
  });
  return rows.map((row) => ({
    rateKey: row.rateKey,
    metakockaTaxFactor: row.metakockaTaxFactor,
    enabled: row.enabled,
  }));
}

export async function replaceTaxMappings(
  principal: Principal,
  mappings: TaxMappingConfig[],
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(async (tx) => {
    await tx.taxMapping.deleteMany({ where: { shopId } });
    if (mappings.length > 0) {
      await tx.taxMapping.createMany({
        data: mappings.map((row) => ({
          shopId,
          rateKey: row.rateKey,
          metakockaTaxFactor: row.metakockaTaxFactor,
          enabled: row.enabled,
        })),
      });
    }
    await bumpVersion(tx, shopId);
  });
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                   */
/* -------------------------------------------------------------------------- */

const treatmentSchema = z.enum(TAX_TREATMENTS);

export async function listTaxOverrides(
  principal: Principal,
): Promise<TaxOverrideConfig[]> {
  const rows = await prisma.taxOverride.findMany({
    where: { shop: { domain: shopDomainOf(principal) } },
    orderBy: [{ scope: "asc" }, { match: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    match: row.match,
    treatment: treatmentSchema.safeParse(row.treatment).data ?? null,
    rateKey: row.rateKey,
    reason: row.reason,
    enabled: row.enabled,
  }));
}

export async function replaceTaxOverrides(
  principal: Principal,
  overrides: Omit<TaxOverrideConfig, "id">[],
): Promise<void> {
  const shopId = await shopIdFor(principal);
  await prisma.$transaction(async (tx) => {
    await tx.taxOverride.deleteMany({ where: { shopId } });
    if (overrides.length > 0) {
      await tx.taxOverride.createMany({
        data: overrides.map((row) => ({
          shopId,
          scope: row.scope,
          match: row.scope === "country" ? row.match.toUpperCase() : row.match,
          treatment: row.treatment,
          rateKey: row.rateKey,
          reason: row.reason,
          enabled: row.enabled,
        })),
      });
    }
    await bumpVersion(tx, shopId);
  });
}

/* -------------------------------------------------------------------------- */
/* The whole configuration                                                     */
/* -------------------------------------------------------------------------- */

/** Everything the engine needs, read in one parallel batch. */
export async function getTaxConfig(principal: Principal): Promise<TaxConfig> {
  const [settings, registrations, merchantRates, mappings, overrides] =
    await Promise.all([
      getTaxSettings(principal),
      listVatRegistrations(principal),
      listMerchantCountryRates(principal),
      listTaxMappings(principal),
      listTaxOverrides(principal),
    ]);

  return {
    version: settings.configVersion,
    domesticCountry: settings.domesticCountry,
    domesticRateKey: settings.domesticRateKey,
    fallbackScope: settings.fallbackScope,
    nonEuNoTaxPolicy: settings.nonEuNoTaxPolicy,
    ossEnabled: settings.ossEnabled,
    registrations: registrations.map(
      ({ kind, country, vatNumber, enabled }) => ({
        kind,
        country,
        vatNumber,
        enabled,
      }),
    ),
    countryRates: effectiveCountryRates(merchantRates),
    mappings,
    overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stored decision, parsed back rather than cast (§4). A snapshot written
 * by an older version of the engine that no longer parses is reported as
 * absent, and the caller decides afresh.
 */
const taxIssueSchema = z.object({
  kind: z.enum(TAX_ISSUE_KINDS),
  severity: z.enum(["blocking", "warning"]),
  message: z.string(),
  lineIds: z.array(z.string()),
  detail: z.record(z.string(), z.unknown()),
});

const lineDecisionSchema = z.object({
  lineId: z.string(),
  sku: z.string(),
  rateKey: z.string().nullable(),
  treatment: treatmentSchema,
  source: z.enum(TAX_SOURCES),
  zeroReason: z.string().nullable(),
  taxableMinor: z.number().int(),
  taxMinor: z.number().int(),
  metakockaTaxFactor: z.string().nullable(),
  mapping: z.enum(["mapped", "missing", "not_applicable"]),
  overrideId: z.string().nullable(),
  issues: z.array(z.enum(TAX_ISSUE_KINDS)),
});

export const taxDecisionSchema: z.ZodType<TaxDecision> = z.object({
  configVersion: z.number().int(),
  currency: z.string(),
  taxesIncluded: z.boolean(),
  destinationCountry: z.string().nullable(),
  jurisdiction: z.enum(["domestic", "eu", "non_eu", "unknown"]),
  customerKind: z.enum(["b2c", "b2b", "unknown"]),
  vatNumber: z.string().nullable(),
  treatment: z.union([treatmentSchema, z.literal("MIXED")]),
  source: z.union([z.enum(TAX_SOURCES), z.literal("MIXED")]),
  lines: z.array(lineDecisionSchema),
  shipping: lineDecisionSchema.nullable(),
  totals: z.object({
    taxableMinor: z.number().int(),
    taxMinor: z.number().int(),
    shopifyTaxMinor: z.number().int(),
    differenceMinor: z.number().int(),
    reconciled: z.boolean(),
  }),
  rateKeys: z.array(z.string()),
  issues: z.array(taxIssueSchema),
  ok: z.boolean(),
});

const registrationSchema = z.object({
  kind: z.enum(["domestic", "oss", "local"]),
  country: z.string(),
  vatNumber: z.string().nullable(),
  enabled: z.boolean(),
});

export const taxConfigSchema: z.ZodType<TaxConfig> = z.object({
  version: z.number().int(),
  domesticCountry: z.string(),
  domesticRateKey: z.string().nullable(),
  fallbackScope: z.enum(["none", "domestic", "eu"]),
  nonEuNoTaxPolicy: z.enum(["review", "export"]),
  ossEnabled: z.boolean(),
  registrations: z.array(registrationSchema),
  countryRates: z.array(
    z.object({
      country: z.string(),
      kind: z.enum([
        "standard",
        "reduced",
        "super_reduced",
        "parking",
        "zero",
        "other",
      ]),
      rateKey: z.string(),
      label: z.string().nullable(),
      origin: z.enum(["reference", "merchant"]),
    }),
  ),
  mappings: z.array(
    z.object({
      rateKey: z.string(),
      metakockaTaxFactor: z.string(),
      enabled: z.boolean(),
    }),
  ),
  overrides: z.array(
    z.object({
      id: z.string(),
      scope: z.enum(["country", "sku"]),
      match: z.string(),
      treatment: treatmentSchema.nullable(),
      rateKey: z.string().nullable(),
      reason: z.string(),
      enabled: z.boolean(),
    }),
  ),
});

export interface StoredTaxSnapshot {
  orderId: string;
  decision: TaxDecision;
  config: TaxConfig;
  refunds: RefundTaxBreakdown[];
  frozenAt: Date | null;
  decidedAt: Date;
}

const refundEntrySchema = z.object({
  lineId: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  rateKey: z.string().nullable(),
  treatment: treatmentSchema,
  source: z.enum(TAX_SOURCES),
  taxableMinor: z.number().int(),
  taxMinor: z.number().int(),
  basis: z.enum(["shopify", "snapshot"]),
});

const refundBreakdownSchema: z.ZodType<RefundTaxBreakdown> = z.object({
  refundId: z.string(),
  createdAt: z.string().nullable(),
  configVersion: z.number().int(),
  currency: z.string(),
  entries: z.array(refundEntrySchema),
  shipping: refundEntrySchema.nullable(),
  totals: z.array(
    z.object({
      rateKey: z.string().nullable(),
      treatment: treatmentSchema,
      taxableMinor: z.number().int(),
      taxMinor: z.number().int(),
    }),
  ),
  totalTaxableMinor: z.number().int(),
  totalTaxMinor: z.number().int(),
  unmatchedLineIds: z.array(z.string()),
});

const refundsSchema = z.array(refundBreakdownSchema);

export async function getTaxSnapshot(
  principal: Principal,
  orderId: string,
): Promise<StoredTaxSnapshot | null> {
  const row = await prisma.orderTaxSnapshot.findFirst({
    where: { orderId, shop: { domain: shopDomainOf(principal) } },
  });
  if (!row) return null;

  const decision = taxDecisionSchema.safeParse(row.decision);
  const config = taxConfigSchema.safeParse(row.configSnapshot);
  if (!decision.success || !config.success) return null;

  return {
    orderId,
    decision: decision.data,
    config: config.data,
    refunds: refundsSchema.safeParse(row.refunds).data ?? [],
    frozenAt: row.frozenAt,
    decidedAt: row.decidedAt,
  };
}

/**
 * Records a decision and materialises it onto the lines.
 *
 * `order_line.tax_factor` becomes the mapped factor — what the document will
 * carry — and the rate, treatment, source and amounts sit beside it for the
 * screens and the verification. A line the decision could not answer keeps a
 * null factor, which is what stops the document builder sending it.
 */
export async function saveTaxDecision(
  principal: Principal,
  input: {
    orderId: string;
    decision: TaxDecision;
    config: TaxConfig;
    now: Date;
  },
): Promise<void> {
  const shopId = await shopIdFor(principal);
  const { orderId, decision, config, now } = input;

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, shopId },
      select: { id: true, taxSnapshot: { select: { decision: true } } },
    });
    if (!order) return;

    /*
     * The same decision again is not news. The reconciler decides on every
     * pass, and most passes find the order exactly as it was; re-writing the
     * row would move `decided_at` and make "decided on" mean "last looked at".
     * The lines are still brought in line below: an order sync rewrites them
     * from the payload, and the payload knows nothing about mappings.
     */
    const unchanged =
      order.taxSnapshot !== null &&
      JSON.stringify(order.taxSnapshot.decision) === JSON.stringify(decision);

    const data = {
      configVersion: decision.configVersion,
      configSnapshot: config as unknown as Prisma.InputJsonValue,
      currency: decision.currency,
      taxesIncluded: decision.taxesIncluded,
      destinationCountry: decision.destinationCountry,
      jurisdiction: decision.jurisdiction,
      customerKind: decision.customerKind,
      vatNumber: decision.vatNumber,
      treatment: decision.treatment,
      source: decision.source,
      taxableMinor: decision.totals.taxableMinor,
      taxMinor: decision.totals.taxMinor,
      shopifyTaxMinor: decision.totals.shopifyTaxMinor,
      reconciled: decision.totals.reconciled,
      ok: decision.ok,
      rateKeys: decision.rateKeys,
      decision: decision as unknown as Prisma.InputJsonValue,
      decidedAt: now,
    };

    if (!unchanged) {
      await tx.orderTaxSnapshot.upsert({
        where: { orderId },
        create: { shopId, orderId, ...data },
        update: data,
      });
    }

    for (const line of decision.lines) {
      await tx.orderLine.updateMany({
        where: { orderId, shopifyLineItemId: line.lineId },
        data: {
          taxFactor: line.metakockaTaxFactor,
          taxRateKey: line.rateKey,
          taxTreatment: line.treatment,
          taxSource: line.source,
          taxableMinor: line.taxableMinor,
          taxMinor: line.taxMinor,
        },
      });
    }
  });
}

/** Marks the decision as history: a document was written under it. */
export async function freezeTaxSnapshot(
  principal: Principal,
  orderId: string,
  now: Date,
): Promise<void> {
  await prisma.orderTaxSnapshot.updateMany({
    where: {
      orderId,
      shop: { domain: shopDomainOf(principal) },
      frozenAt: null,
    },
    data: { frozenAt: now },
  });
}

/** Appends refund reversals, keyed by refund id so a re-read never duplicates one. */
export async function recordRefundBreakdowns(
  principal: Principal,
  orderId: string,
  breakdowns: RefundTaxBreakdown[],
): Promise<void> {
  const row = await prisma.orderTaxSnapshot.findFirst({
    where: { orderId, shop: { domain: shopDomainOf(principal) } },
    select: { id: true, refunds: true },
  });
  if (!row) return;

  const existing = refundsSchema.safeParse(row.refunds).data ?? [];
  const byId = new Map(existing.map((entry) => [entry.refundId, entry]));
  for (const breakdown of breakdowns) byId.set(breakdown.refundId, breakdown);

  await prisma.orderTaxSnapshot.update({
    where: { id: row.id },
    data: { refunds: [...byId.values()] as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Removes the VAT identifier from an order's snapshot (docs/BUILD_SPEC.md
 * §2.4), keeping every rate, amount, treatment and reason.
 *
 * A VAT number identifies a business, and for a sole trader that is a person.
 * It is the one field on the snapshot that can be, so it goes when the
 * order's payload does; the decision it explained stays explained without it.
 */
export async function redactTaxSnapshot(orderId: string): Promise<void> {
  const row = await prisma.orderTaxSnapshot.findUnique({
    where: { orderId },
    select: { id: true, decision: true },
  });
  if (!row) return;

  const decision = taxDecisionSchema.safeParse(row.decision);
  const scrubbed: TaxDecision | null = decision.success
    ? {
        ...decision.data,
        vatNumber: decision.data.vatNumber === null ? null : "[redacted]",
        lines: decision.data.lines.map((line) => ({
          ...line,
          zeroReason:
            line.zeroReason && decision.data.vatNumber
              ? line.zeroReason.replace(decision.data.vatNumber, "[redacted]")
              : line.zeroReason,
        })),
      }
    : null;

  await prisma.orderTaxSnapshot.update({
    where: { id: row.id },
    data: {
      vatNumber: null,
      ...(scrubbed
        ? { decision: scrubbed as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Diagnostics facts                                                           */
/* -------------------------------------------------------------------------- */

/** How far back "recent" reaches for observed rates and warnings. */
const DIAGNOSTICS_WINDOW_DAYS = 90;
/** The most recent decisions read for diagnostics. Enough to see every rate in use. */
const DIAGNOSTICS_LIMIT = 500;

export async function getTaxDiagnosticsFacts(
  principal: Principal,
  now: Date,
  options: {
    /**
     * Whether to read each recent decision for its warnings. The Taxes & VAT
     * page wants them; readiness, which runs on every Home and Settings load,
     * does not need a few hundred JSON documents to say whether a rate is
     * unmapped.
     */
    includeWarnings?: boolean;
  } = {},
): Promise<TaxDiagnosticsFacts> {
  const domain = shopDomainOf(principal);
  const since = new Date(
    now.getTime() - DIAGNOSTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const includeWarnings = options.includeWarnings ?? true;

  const [config, snapshots, exceptions] = await Promise.all([
    getTaxConfig(principal),
    prisma.orderTaxSnapshot.findMany({
      where: { shop: { domain }, decidedAt: { gte: since } },
      select: {
        rateKeys: true,
        destinationCountry: true,
        decidedAt: true,
        decision: includeWarnings,
      },
      orderBy: { decidedAt: "desc" },
      take: DIAGNOSTICS_LIMIT,
    }),
    prisma.exception.groupBy({
      by: ["kind"],
      where: {
        shop: { domain },
        status: "open",
        kind: {
          in: [
            "tax_mapping_missing",
            "tax_treatment_unknown",
            "tax_reconciliation_failed",
            "tax_data_insufficient",
            "vat_registration_configuration_error",
            "tax_undeterminable",
          ],
        },
      },
      _count: { _all: true },
    }),
  ]);

  const observed = new Map<
    string,
    { orders: number; countries: Set<string>; lastSeenAt: Date }
  >();
  const warnings = new Map<TaxIssueKind, number>();

  for (const snapshot of snapshots) {
    for (const rateKey of snapshot.rateKeys) {
      const entry = observed.get(rateKey) ?? {
        orders: 0,
        countries: new Set<string>(),
        lastSeenAt: snapshot.decidedAt,
      };
      entry.orders += 1;
      if (snapshot.destinationCountry)
        entry.countries.add(snapshot.destinationCountry);
      if (snapshot.decidedAt > entry.lastSeenAt)
        entry.lastSeenAt = snapshot.decidedAt;
      observed.set(rateKey, entry);
    }

    if (!includeWarnings) continue;
    const decision = taxDecisionSchema.safeParse(snapshot.decision);
    if (decision.success) {
      for (const issue of decision.data.issues) {
        if (issue.severity !== "warning") continue;
        warnings.set(issue.kind, (warnings.get(issue.kind) ?? 0) + 1);
      }
    }
  }

  return {
    config,
    observed: [...observed.entries()].map(([rateKey, entry]) => ({
      rateKey,
      orders: entry.orders,
      countries: [...entry.countries].sort(),
      lastSeenAt: entry.lastSeenAt.toISOString(),
    })),
    openExceptions: exceptions.map((row) => ({
      kind: row.kind,
      count: row._count._all,
    })),
    recentWarnings: [...warnings.entries()].map(([kind, count]) => ({
      kind,
      count,
    })),
    decidedOrders: snapshots.length,
  };
}
