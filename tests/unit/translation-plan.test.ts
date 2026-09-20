import { describe, expect, it } from "vitest";

import {
  classifyField,
  isTranslatableField,
  mayOverwrite,
  planResource,
  summarisePlan,
  type PlanInput,
} from "~/domain/translations/plan";
import type {
  ExistingTranslation,
  OwnershipRecord,
  SourceField,
} from "~/domain/translations/types";

/**
 * The ownership and overwrite rules (docs/translations.md § Ownership and
 * overwrite). The one that matters most: a person's correction is never sent
 * back to the model unless the language says everything may be overwritten.
 */

const hash = (value: string) => `h(${value})`;

function field(key: string, value: string, type = "STRING"): SourceField {
  return { key, value, digest: `d-${key}`, type };
}

function translation(
  key: string,
  value: string,
  outdated = false,
): ExistingTranslation {
  return { key, value, outdated, updatedAt: null };
}

function aiRecord(key: string, value: string, locale = "de"): OwnershipRecord {
  return { key, locale, owner: "ai", valueHash: hash(value) };
}

function plan(overrides: Partial<PlanInput>): ReturnType<typeof planResource> {
  return planResource({
    fields: [field("title", "Boom"), field("body_html", "<p>A boom.</p>", "HTML")],
    translations: [],
    ownership: [],
    hash,
    mode: "missing",
    policy: "update_ai_managed",
    sourceLocale: "en",
    targetLocale: "de",
    ...overrides,
  });
}

describe("classifyField", () => {
  it("is missing with no translation or an empty one", () => {
    expect(classifyField(undefined, undefined, hash)).toBe("missing");
    expect(classifyField(translation("title", ""), undefined, hash)).toBe(
      "missing",
    );
  });

  it("reports outdated before ownership", () => {
    expect(
      classifyField(
        translation("title", "Gabelbaum", true),
        aiRecord("title", "Gabelbaum"),
        hash,
      ),
    ).toBe("outdated");
  });

  it("calls a translation this app never wrote existing, and an AI one with a matching hash ai", () => {
    expect(classifyField(translation("title", "Baum"), undefined, hash)).toBe(
      "existing",
    );
    expect(
      classifyField(translation("title", "Baum"), aiRecord("title", "Baum"), hash),
    ).toBe("ai");
  });

  it("notices a person changed what the AI wrote", () => {
    // The AI wrote "Baum"; Shopify now holds "Gabelbaum". Somebody fixed it.
    expect(
      classifyField(
        translation("title", "Gabelbaum"),
        aiRecord("title", "Baum"),
        hash,
      ),
    ).toBe("manual");
  });
});

describe("mayOverwrite", () => {
  it("protects human work under every policy but overwrite_all", () => {
    for (const state of ["manual", "existing"] as const) {
      expect(mayOverwrite(state, "protect_existing")).toBe(false);
      expect(mayOverwrite(state, "update_ai_managed")).toBe(false);
      expect(mayOverwrite(state, "overwrite_all")).toBe(true);
    }
  });

  it("lets the default policy update only what the AI wrote", () => {
    expect(mayOverwrite("ai", "update_ai_managed")).toBe(true);
    expect(mayOverwrite("ai", "protect_existing")).toBe(false);
  });
});

describe("planResource", () => {
  it("translates missing fields and nothing else in missing mode", () => {
    const decisions = plan({
      translations: [translation("title", "Boom")],
    });
    expect(decisions.map((d) => [d.field.key, d.kind])).toEqual([
      ["title", "skip"],
      ["body_html", "translate"],
    ]);
    expect(summarisePlan(decisions)).toEqual({
      translate: 1,
      copy: 0,
      skipped: { up_to_date: 1 },
    });
  });

  it("never sends a manual correction back to the model, even outdated, even forced", () => {
    // The AI once wrote "Baum"; a person corrected it to "Gabelbaum"; the
    // source has since changed, so Shopify marks it outdated.
    const corrected = translation("title", "Gabelbaum", true);
    const record = aiRecord("title", "Baum");

    for (const mode of ["missing_outdated", "force"] as const) {
      const decisions = plan({
        translations: [corrected],
        ownership: [record],
        mode,
        policy: "update_ai_managed",
      });
      const title = decisions.find((d) => d.field.key === "title");
      expect(title?.kind).toBe("skip");
      expect(title && title.kind === "skip" ? title.reason : null).toBe(
        "protected_manual",
      );
    }
  });

  it("updates an outdated AI translation under the default policy, but not under protect_existing", () => {
    const stale = translation("title", "Baum", true);
    const record = aiRecord("title", "Baum");

    const updated = plan({
      translations: [stale],
      ownership: [record],
      mode: "missing_outdated",
    }).find((d) => d.field.key === "title");
    expect(updated?.kind).toBe("translate");

    const kept = plan({
      translations: [stale],
      ownership: [record],
      mode: "missing_outdated",
      policy: "protect_existing",
    }).find((d) => d.field.key === "title");
    expect(kept?.kind).toBe("skip");
    expect(kept && kept.kind === "skip" ? kept.reason : null).toBe(
      "protected_existing",
    );
  });

  it("treats a translation Shopify held before this app as human work", () => {
    const decisions = plan({
      translations: [translation("title", "Gabelbaum")],
      mode: "force",
      policy: "update_ai_managed",
    });
    const title = decisions.find((d) => d.field.key === "title");
    expect(title && title.kind === "skip" ? title.reason : null).toBe(
      "protected_manual",
    );
  });

  it("rewrites everything only under overwrite_all", () => {
    const decisions = plan({
      translations: [translation("title", "Gabelbaum")],
      mode: "force",
      policy: "overwrite_all",
    });
    expect(decisions.every((d) => d.kind === "translate")).toBe(true);
  });

  it("copies the source verbatim when the resource is written in the target language", () => {
    // An article written in Slovenian in an English store: its own text is
    // the Slovenian translation, and no model is asked.
    const decisions = plan({
      sourceLocale: "sl",
      targetLocale: "sl",
      translations: [translation("title", "Boom")],
    });
    expect(decisions.map((d) => [d.field.key, d.kind])).toEqual([
      ["title", "skip"],
      ["body_html", "copy_source"],
    ]);
  });

  it("leaves handles, empty fields and non-text alone", () => {
    const decisions = plan({
      fields: [
        field("handle", "boom"),
        field("title", "   "),
        field("value", "https://x", "URI"),
      ],
    });
    expect(decisions.map((d) => (d.kind === "skip" ? d.reason : d.kind))).toEqual([
      "identifier",
      "empty_source",
      "not_translatable",
    ]);
    expect(isTranslatableField(field("title", "Boom"))).toBe(true);
    expect(isTranslatableField(field("handle", "boom"))).toBe(false);
  });

  it("ignores ownership records for other locales", () => {
    const decisions = plan({
      translations: [translation("title", "Baum")],
      ownership: [aiRecord("title", "Baum", "it")],
      mode: "force",
    });
    const title = decisions.find((d) => d.field.key === "title");
    // No record for "de": Shopify held it, so it is human work.
    expect(title && title.kind === "skip" ? title.reason : null).toBe(
      "protected_manual",
    );
  });
});
