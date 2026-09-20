import { afterAll, beforeAll, expect, it } from "vitest";

import {
  claimProfileBuild,
  getStoreProfile,
  listTerms,
  lookupMemory,
  releaseProfileBuild,
  rememberTranslations,
  replaceDiscoveredTerms,
  saveStoreProfile,
  type MemoryWrite,
} from "~/adapters/db/repositories/translation-intelligence.server";
import type { TermCandidate } from "~/domain/translations/terminology";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * What only the database can show about translation intelligence
 * (docs/translations.md § Concurrency): two workers learning the same term
 * at once, a person's translation standing against the machine's, and one
 * winner for the profile build.
 */

describeDatabase("translation intelligence", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant("intelligence");
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant);
  });

  function write(sourceText: string, targetText: string, resourceId = "gid://shopify/Link/1"): MemoryWrite {
    return {
      sourceLocale: "en",
      targetLocale: "sl",
      sourceKey: sourceText.toLowerCase(),
      sourceText,
      targetText,
      resourceType: "LINK",
      resourceId,
    };
  }

  it("counts concurrent identical learnings once each and never errors", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        rememberTranslations(tenant.principal, [write("Wing", "Wing", `gid://shopify/Link/${i}`)], "ai", new Date()),
      ),
    );
    const [entry] = await lookupMemory(tenant.principal, { sourceLocale: "en", targetLocales: ["sl"], keys: ["wing"] });
    expect(entry).toMatchObject({ sourceText: "Wing", targetText: "Wing", origin: "ai", usageCount: 12 });
  });

  it("keeps the first machine answer over a later disagreeing one, and counts the disagreement", async () => {
    await rememberTranslations(tenant.principal, [write("Used", "Rabljeno")], "ai", new Date());
    await rememberTranslations(tenant.principal, [write("Used", "Uporabljeno")], "ai", new Date());
    const [entry] = await lookupMemory(tenant.principal, { sourceLocale: "en", targetLocales: ["sl"], keys: ["used"] });
    expect(entry).toMatchObject({ targetText: "Rabljeno", usageCount: 1, origin: "ai" });
    // The disagreement is recorded on the row.
    const { prisma } = await import("./harness");
    const row = await prisma.translationMemory.findFirst({ where: { shopId: tenant.shopId, sourceKey: "used" } });
    expect(row?.conflicts).toBe(1);
  });

  it("lets a person's translation replace the machine's and never the other way round", async () => {
    await rememberTranslations(tenant.principal, [write("Foil", "Folija")], "ai", new Date());
    await rememberTranslations(tenant.principal, [write("Foil", "Foil")], "manual", new Date());
    let [entry] = await lookupMemory(tenant.principal, { sourceLocale: "en", targetLocales: ["sl"], keys: ["foil"] });
    expect(entry).toMatchObject({ targetText: "Foil", origin: "manual" });
    await rememberTranslations(tenant.principal, [write("Foil", "Folija")], "ai", new Date());
    [entry] = await lookupMemory(tenant.principal, { sourceLocale: "en", targetLocales: ["sl"], keys: ["foil"] });
    expect(entry).toMatchObject({ targetText: "Foil", origin: "manual" });
  });

  it("keeps a regional locale's memory apart from the language's and finds both", async () => {
    await rememberTranslations(tenant.principal, [{ ...write("Cart", "Warenkorb"), targetLocale: "de" }], "ai", new Date());
    await rememberTranslations(tenant.principal, [{ ...write("Cart", "Einkaufswagen"), targetLocale: "de-AT" }], "ai", new Date());
    const rows = await lookupMemory(tenant.principal, { sourceLocale: "en", targetLocales: ["de-AT", "de"], keys: ["cart"] });
    expect(rows.map((row) => `${row.targetLocale}:${row.targetText}`).sort()).toEqual(["de-AT:Einkaufswagen", "de:Warenkorb"]);
  });

  it("merges discovered terms from concurrent passes and prunes what the store no longer has", async () => {
    const candidate = (term: string, occurrences: number): TermCandidate => ({
      term,
      normalised: term.toLowerCase(),
      classification: "category",
      confidence: 0.92,
      evidence: { menu: 1 },
      occurrences,
    });
    const first = new Date();
    await Promise.all([
      replaceDiscoveredTerms(tenant.principal, "en", [candidate("Wing", 1), candidate("Foil", 1)], first),
      replaceDiscoveredTerms(tenant.principal, "en", [candidate("Wing", 1), candidate("Foil", 1)], first),
    ]);
    let terms = await listTerms(tenant.principal, "en");
    expect(terms.map((term) => term.normalised).sort()).toEqual(["foil", "wing"]);
    const later = new Date(first.getTime() + 1000);
    const count = await replaceDiscoveredTerms(tenant.principal, "en", [candidate("Wing", 40)], later);
    expect(count).toBe(1);
    terms = await listTerms(tenant.principal, "en");
    expect(terms.map((term) => term.normalised)).toEqual(["wing"]);
  });

  it("grants the profile build lease to exactly one of concurrent claimants, and takes over a dead one", async () => {
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimProfileBuild(tenant.principal, now, 600_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    // While the lease is held nobody else gets it…
    expect(await claimProfileBuild(tenant.principal, new Date(now.getTime() + 1000), 600_000)).toBe(false);
    // …until it is older than the lease.
    expect(await claimProfileBuild(tenant.principal, new Date(now.getTime() + 601_000), 600_000)).toBe(true);
    await releaseProfileBuild(tenant.principal, null, now);
    const saved = await saveStoreProfile(tenant.principal, {
      profile: {
        storeDescription: "A test store.",
        industries: ["testing"],
        audience: "",
        importantTerminology: [],
        likelyBrands: [],
        productFamilies: [],
        technicalVocabulary: [],
        commonAbbreviations: [],
        localisationNotes: "",
      },
      summary: "testing",
      promptVersion: "profile-v1",
      model: "test",
      vocabulary: ["wing"],
      sampleStats: { products: 1, collections: 1, menuItems: 1 },
      now,
    });
    expect(saved.version).toBe(1);
    expect(saved.generatingAt).toBeNull();
    expect((await getStoreProfile(tenant.principal))?.profile?.industries).toEqual(["testing"]);
  });
});
