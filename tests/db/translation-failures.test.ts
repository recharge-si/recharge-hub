import { afterAll, beforeAll, expect, it } from "vitest";

import {
  clearFailure,
  isBackingOff,
  listFailures,
  recordFailure,
} from "~/adapters/db/repositories/translation-failures.server";
import {
  getLanguageSettings,
  saveLanguageSettings,
} from "~/adapters/db/repositories/translations.server";
import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * Remembered failures and kept fields (docs/translations.md § Failures,
 * § Kept in the original language), against PostgreSQL: a failure on the
 * same source counts up, one on a changed source starts over, and a
 * language's kept fields survive a save.
 */
describeDatabase("translation failures", () => {
  let tenant: TestTenant;
  const resourceId = "gid://shopify/Product/1";
  const now = new Date("2026-09-26T12:00:00Z");

  beforeAll(async () => {
    tenant = await createTenant("failures");
  });
  afterAll(async () => {
    await destroyTenant(tenant);
  });

  it("counts failures on the same source up and starts over when it changes", async () => {
    const record = async (sourceKey: string) => {
      const previous = (await listFailures(tenant.principal, resourceId)).get(
        "de",
      );
      await recordFailure(
        tenant.principal,
        { resourceId, locale: "de", sourceKey, error: "Cut short.", previous },
        now,
      );
      return (await listFailures(tenant.principal, resourceId)).get("de");
    };

    expect((await record("k1"))?.attempts).toBe(1);
    expect((await record("k1"))?.attempts).toBe(2);
    const third = await record("k1");
    expect(third?.attempts).toBe(3);
    expect(isBackingOff(third, "k1", now)).toBe(true);
    const fourth = await record("k1");
    expect(fourth?.retryAfter).toBeNull();
    expect((await record("k2"))?.attempts).toBe(1);

    await clearFailure(tenant.principal, resourceId, "de");
    expect((await listFailures(tenant.principal, resourceId)).size).toBe(0);
  });

  it("keeps a language's kept fields", async () => {
    const settings = await getLanguageSettings(tenant.principal, "de");
    await saveLanguageSettings(tenant.principal, {
      ...settings,
      keepOriginal: ["product_titles", "product_options"],
    });
    expect(
      (await getLanguageSettings(tenant.principal, "de")).keepOriginal,
    ).toEqual(["product_titles", "product_options"]);
  });
});
