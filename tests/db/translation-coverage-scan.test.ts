import { afterAll, beforeAll, expect, it } from "vitest";

import {
  finishCoverageScan,
  getCoverageScan,
  isScanActive,
  recordScanProgress,
  replaceCoverageForType,
  startCoverageScan,
} from "~/adapters/db/repositories/translation-coverage-scan.server";
import { getCoverage } from "~/adapters/db/repositories/translations.server";
import type { CoverageRow } from "~/domain/translations/estimate";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The coverage count's progress row and the per-type cache writes
 * (docs/translations.md § Coverage), against PostgreSQL: a replaced run
 * cannot move the progress, and one type's rows replace only that type.
 */
describeDatabase("coverage count", () => {
  let tenant: TestTenant;
  const now = new Date("2026-09-26T12:00:00Z");

  beforeAll(async () => {
    tenant = await createTenant("coverage-scan");
  });
  afterAll(async () => {
    await destroyTenant(tenant);
  });

  const row = (resourceType: string, translated: number): CoverageRow => ({
    locale: "sl",
    resourceType,
    resources: 10,
    fields: 20,
    translated,
    outdated: 0,
    missing: 20 - translated,
    missingChars: 0,
    outdatedChars: 0,
  });

  it("moves only the current run, and ends it", async () => {
    await startCoverageScan(
      tenant.principal,
      { runId: "a", typesTotal: 12, expectedResources: null },
      now,
    );
    await startCoverageScan(
      tenant.principal,
      { runId: "b", typesTotal: 12, expectedResources: 40 },
      now,
    );
    const progress = {
      typesDone: 1,
      currentType: "COLLECTION",
      resourcesRead: 10,
      unread: [],
    };
    expect(await recordScanProgress(tenant.principal, "a", progress, now)).toBe(
      false,
    );
    expect(await recordScanProgress(tenant.principal, "b", progress, now)).toBe(
      true,
    );
    const running = await getCoverageScan(tenant.principal);
    expect(running).toMatchObject({
      runId: "b",
      status: "running",
      typesDone: 1,
      resourcesRead: 10,
      expectedResources: 40,
    });
    expect(isScanActive(running, now)).toBe(true);

    await finishCoverageScan(
      tenant.principal,
      "b",
      { status: "done", error: null },
      now,
    );
    expect(isScanActive(await getCoverageScan(tenant.principal), now)).toBe(
      false,
    );
  });

  it("replaces one type's rows and leaves the others", async () => {
    await replaceCoverageForType(
      tenant.principal,
      "PRODUCT",
      [row("PRODUCT", 5)],
      now,
    );
    await replaceCoverageForType(
      tenant.principal,
      "PAGE",
      [row("PAGE", 2)],
      now,
    );
    await replaceCoverageForType(
      tenant.principal,
      "PRODUCT",
      [row("PRODUCT", 9)],
      now,
    );
    const coverage = await getCoverage(tenant.principal);
    expect(
      coverage.rows.map((r) => [r.resourceType, r.translated]).sort(),
    ).toEqual([
      ["PAGE", 2],
      ["PRODUCT", 9],
    ]);
  });
});
