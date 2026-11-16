import { describe, expect, it } from "vitest";

import {
  isBackingOff,
  nextRetry,
  type StoredFailure,
} from "~/adapters/db/repositories/translation-failures.server";
import {
  accumulateResource,
  newCoverage,
} from "~/domain/translations/coverage";
import { planResource } from "~/domain/translations/plan";
import { keptKeys, type SourceField } from "~/domain/translations/types";

/**
 * What keeps automatic translation from paying for the same thing twice
 * (docs/translations.md § Failures) and the fields a language keeps in the
 * source language (§ Kept in the original language).
 */

const hash = (value: string) => `h(${value})`;

function field(key: string, value: string): SourceField {
  return { key, value, digest: `d-${key}`, type: "STRING" };
}

const NOW = new Date("2026-09-26T12:00:00Z");
const DAY = 86_400_000;

function failure(overrides: Partial<StoredFailure> = {}): StoredFailure {
  return {
    locale: "de",
    sourceKey: "k1",
    attempts: 1,
    lastError: "The reply left out title.",
    failedAt: NOW,
    retryAfter: new Date(NOW.getTime() + DAY),
    ...overrides,
  };
}

describe("failure backoff", () => {
  it("waits a day, then three, then seven, then until the source changes", () => {
    expect(nextRetry(1, NOW)).toEqual(new Date(NOW.getTime() + DAY));
    expect(nextRetry(2, NOW)).toEqual(new Date(NOW.getTime() + 3 * DAY));
    expect(nextRetry(3, NOW)).toEqual(new Date(NOW.getTime() + 7 * DAY));
    expect(nextRetry(4, NOW)).toBeNull();
  });

  it("backs off only on the same source and only until the retry time", () => {
    expect(isBackingOff(undefined, "k1", NOW)).toBe(false);
    expect(isBackingOff(failure(), "k1", NOW)).toBe(true);
    expect(isBackingOff(failure(), "k2", NOW)).toBe(false);
    expect(
      isBackingOff(failure(), "k1", new Date(NOW.getTime() + 2 * DAY)),
    ).toBe(false);
    expect(isBackingOff(failure({ retryAfter: null }), "k1", NOW)).toBe(true);
  });
});

describe("kept in the original language", () => {
  it("maps choices to the keys of each resource type", () => {
    expect([...keptKeys(["product_titles"], "PRODUCT")]).toEqual(["title"]);
    expect([...keptKeys(["product_titles"], "COLLECTION")]).toEqual([]);
    expect([...keptKeys(["product_options"], "PRODUCT_OPTION_VALUE")]).toEqual([
      "name",
    ]);
  });

  it("never sends a kept field to the AI", () => {
    const decisions = planResource({
      fields: [field("title", "Boom"), field("body_html", "A boom.")],
      translations: [],
      ownership: [],
      hash,
      mode: "force",
      policy: "overwrite_all",
      sourceLocale: "en",
      targetLocale: "de",
      keep: keptKeys(["product_titles"], "PRODUCT"),
    });
    expect(decisions.map((d) => [d.field.key, d.kind])).toEqual([
      ["title", "skip"],
      ["body_html", "translate"],
    ]);
    expect(decisions[0]).toMatchObject({ reason: "kept_original" });
  });

  it("does not count a kept field as missing", () => {
    const acc = newCoverage();
    accumulateResource(acc, {
      resourceType: "PRODUCT",
      fields: [field("title", "Boom"), field("body_html", "A boom.")],
      translations: new Map(),
      locales: ["de", "fr"],
      keep: (locale) =>
        keptKeys(locale === "de" ? ["product_titles"] : [], "PRODUCT"),
    });
    expect(acc.get("de\u0000PRODUCT")).toMatchObject({ fields: 1, missing: 1 });
    expect(acc.get("fr\u0000PRODUCT")).toMatchObject({ fields: 2, missing: 2 });
  });
});
