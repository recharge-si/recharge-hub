import { describe, expect, it } from "vitest";

import {
  accumulateResource,
  coverageRows,
  newCoverage,
  totalsFor,
} from "~/domain/translations/coverage";
import {
  coveragePercent,
  estimateRun,
  formatCount,
} from "~/domain/translations/estimate";
import {
  PRICING_VERSION,
  estimateCostMicros,
  formatMicrosUsd,
  pricingFor,
} from "~/domain/translations/pricing";
import { parseDetectionReply } from "~/domain/translations/detection";
import {
  buildTranslationMessages,
  parseTranslationReply,
} from "~/domain/translations/prompt";
import type { SourceField } from "~/domain/translations/types";

/**
 * Pricing, estimates, coverage and the prompt round trip
 * (docs/translations.md § AI usage, § Coverage, § The provider).
 */

describe("pricing", () => {
  it("prices a known model and a dated snapshot of it, and refuses an unknown one", () => {
    expect(pricingFor("gpt-4.1-mini")).not.toBeNull();
    expect(pricingFor("gpt-4.1-mini-2025-04-14")).toEqual(pricingFor("gpt-4.1-mini"));
    // The longest family prefix wins: not priced as "gpt-4.1".
    expect(pricingFor("gpt-4.1-nano-2025-04-14")).toEqual(pricingFor("gpt-4.1-nano"));
    expect(pricingFor("some-future-model")).toBeNull();
    expect(estimateCostMicros("some-future-model", {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 1000,
    })).toBeNull();
  });

  it("costs a million input and output tokens at the listed rate, exactly", () => {
    // gpt-4.1-mini: $0.40 in, $1.60 out per million.
    expect(
      estimateCostMicros("gpt-4.1-mini", {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBe(2_000_000);
  });

  it("prices cached input at its own rate and never counts more cached than input", () => {
    const full = estimateCostMicros("gpt-4.1-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const cached = estimateCostMicros("gpt-4.1-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    const overCached = estimateCostMicros("gpt-4.1-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 5_000_000,
      outputTokens: 0,
    });
    expect(full).toBe(400_000);
    expect(cached).toBe(100_000);
    expect(overCached).toBe(cached);
  });

  it("formats micro-dollars for a person", () => {
    expect(formatMicrosUsd(18_420_000)).toBe("$18.42");
    expect(formatMicrosUsd(1_234n)).toBe("$0.0012");
    expect(formatMicrosUsd(0)).toBe("$0.00");
    expect(formatMicrosUsd(null)).toBe("—");
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("coverage and estimate", () => {
  function fields(): SourceField[] {
    return [
      { key: "title", value: "Patrik 5-Wave", digest: "a", type: "STRING" },
      { key: "body_html", value: "<p>".padEnd(400, "x"), digest: "b", type: "HTML" },
      { key: "handle", value: "patrik-5-wave", digest: "c", type: "STRING" },
    ];
  }

  it("counts translated, outdated and missing fields per language, ignoring handles", () => {
    const acc = newCoverage();
    accumulateResource(acc, {
      resourceType: "PRODUCT",
      fields: fields(),
      locales: ["de", "it"],
      translations: new Map([
        ["de", [{ key: "title", value: "Patrik 5-Wave", outdated: false, updatedAt: null }]],
        ["it", [{ key: "body_html", value: "…", outdated: true, updatedAt: null }]],
      ]),
    });
    const rows = coverageRows(acc);
    expect(rows.map((row) => [row.locale, row.fields, row.translated, row.outdated, row.missing])).toEqual([
      ["de", 2, 1, 0, 1],
      ["it", 2, 0, 1, 1],
    ]);
    expect(rows[0]?.missingChars).toBe(400);
    expect(rows[1]?.outdatedChars).toBe(400);
    expect(rows[1]?.missingChars).toBe(13);
    expect(coveragePercent(rows.filter((row) => row.locale === "de"))).toBe(50);
    expect(coveragePercent([])).toBeNull();
    expect(totalsFor(rows, "it").fields).toBe(2);
    expect(totalsFor(rows, "it", ["PAGE"]).fields).toBe(0);
  });

  it("estimates from the coverage rows for the chosen languages, types and mode", () => {
    const rows = [
      {
        locale: "de",
        resourceType: "PRODUCT",
        resources: 10,
        fields: 20,
        translated: 10,
        outdated: 5,
        missing: 5,
        missingChars: 3500,
        outdatedChars: 7000,
      },
      {
        locale: "de",
        resourceType: "PAGE",
        resources: 2,
        fields: 4,
        translated: 0,
        outdated: 0,
        missing: 4,
        missingChars: 350,
        outdatedChars: 0,
      },
    ];
    const missing = estimateRun({
      rows,
      locales: ["de"],
      resourceTypes: ["PRODUCT"],
      mode: "missing",
      model: "gpt-4.1-mini",
      coverageAt: null,
    });
    expect(missing.fields).toBe(5);
    expect(missing.inputTokens).toBe(1000 + 5 * 700);
    expect(missing.outputTokens).toBe(1150);
    expect(missing.costMicros).not.toBeNull();
    expect(missing.priced).toBe(true);

    const both = estimateRun({
      rows,
      locales: ["de"],
      resourceTypes: ["PRODUCT", "PAGE"],
      mode: "missing_outdated",
      model: "gpt-4.1-mini",
      coverageAt: null,
    });
    expect(both.fields).toBe(14);
    expect(both.perLocale).toEqual([
      { locale: "de", fields: 14, costMicros: both.costMicros },
    ]);

    const unpriced = estimateRun({
      rows,
      locales: ["de"],
      resourceTypes: ["PRODUCT"],
      mode: "force",
      model: "mystery",
      coverageAt: null,
    });
    expect(unpriced.fields).toBe(20);
    expect(unpriced.costMicros).toBeNull();
    expect(unpriced.priced).toBe(false);
  });

  it("formats counts the way the usage page shows them", () => {
    expect(formatCount(980)).toBe("980");
    expect(formatCount(12_842)).toBe("12,842");
    expect(formatCount(680_000)).toBe("680K");
    expect(formatCount(6_800_000)).toBe("6.8M");
    expect(formatCount(52_000_000)).toBe("52M");
  });
});

describe("prompt", () => {
  const fields: SourceField[] = [
    { key: "title", value: "Boom", digest: "a", type: "STRING" },
    { key: "body_html", value: "<p>A boom.</p>", digest: "b", type: "HTML" },
  ];

  it("carries the glossary and protected terms, and numbers the fields", () => {
    const messages = buildTranslationMessages({
      sourceLocale: "en",
      targetLocale: "de",
      resourceKind: "Product",
      resourceTitle: "Boom",
      fields,
      glossary: [
        { kind: "protect", targetLocale: null, sourceTerm: "Patrik", targetTerm: null },
        { kind: "translate", targetLocale: "de", sourceTerm: "Boom", targetTerm: "Gabelbaum" },
        { kind: "translate", targetLocale: "it", sourceTerm: "Boom", targetTerm: "Boma" },
      ],
      storeName: "Recharge",
      storeContext: null,
      resourceContext: null,
      terminology: [],
      memoryHints: [],
    });
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    expect(system).toContain("from English (en) into German (de)");
    expect(system).toContain('"Recharge"');
    expect(user).toContain('"Patrik"');
    expect(user).toContain('"Boom" → "Gabelbaum"');
    expect(user).not.toContain("Boma");
    expect(user).toContain("Field 1 (title, text)");
    expect(user).toContain("Field 2 (body_html, HTML)");
  });

  it("reads a complete reply back by number and refuses an incomplete or padded one", () => {
    const ok = parseTranslationReply(
      '{"translations":{"1":"Gabelbaum","2":"<p>Ein Gabelbaum.</p>"}}',
      fields,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect([...ok.values]).toEqual([
      ["title", "Gabelbaum"],
      ["body_html", "<p>Ein Gabelbaum.</p>"],
    ]);

    const fenced = parseTranslationReply(
      '```json\n{"translations":{"1":"A","2":"B"}}\n```',
      fields,
    );
    expect(fenced.ok).toBe(true);

    const short = parseTranslationReply('{"translations":{"1":"Gabelbaum"}}', fields);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain("body_html");

    const padded = parseTranslationReply(
      '{"translations":{"1":"A","2":"B","3":"C"}}',
      fields,
    );
    expect(padded.ok).toBe(false);
    expect(parseTranslationReply("not json", fields).ok).toBe(false);
  });

  it("reads a detection reply and caps its confidence by the sample's length", () => {
    const long = "Deska za jadranje na deski je pripravljena za novo sezono na obali.";
    expect(parseDetectionReply('{"locale":"SL","confidence":0.9}', long)).toMatchObject({
      locale: "sl",
      confidence: 0.9,
      shortSample: false,
    });
    expect(parseDetectionReply('{"locale":"en","confidence":0.99}', "Foil")).toMatchObject({
      locale: "en",
      confidence: 0.45,
      reportedConfidence: 0.99,
      shortSample: true,
    });
    expect(parseDetectionReply("nope", long)).toBeNull();
  });
});
