import { describe, expect, it } from "vitest";

import {
  isMemorable,
  memorablePairs,
  memoryKey,
  reuseVerdict,
  selectMemoryHints,
  type MemoryEntry,
} from "~/domain/translations/memory";
import type { GlossaryTerm, SourceField } from "~/domain/translations/types";

/**
 * Translation memory (docs/translations.md § Translation memory): what is
 * remembered, when a remembered answer is written without asking the
 * model, and when it is only a hint.
 */

function field(value: string, type = "STRING", key = "title"): SourceField {
  return { key, value, digest: "d", type };
}

function entry(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "sourceText" | "targetText">): MemoryEntry {
  return { id: "m1", origin: "ai", usageCount: 1, resourceType: "LINK", ...partial };
}

const context = { resourceType: "LINK", glossary: [] as GlossaryTerm[], targetLocale: "sl" };

describe("memoryKey and isMemorable", () => {
  it("keys a string by its normalised form", () => {
    expect(memoryKey("  Wing  Foil ")).toBe("wing foil");
    expect(memoryKey("Wing-Foil")).toBe("wing-foil");
    expect(memoryKey("<p>Used</p>")).toBe("used");
    expect(memoryKey("Used.")).toBe("used");
  });

  it("remembers short plain text only", () => {
    expect(isMemorable(field("Wing"))).toBe(true);
    expect(isMemorable(field("Neoprene Suits", "SINGLE_LINE_TEXT_FIELD"))).toBe(true);
    expect(isMemorable(field("<p>Wing</p>", "HTML"))).toBe(false);
    expect(isMemorable(field("Wing <b>x</b>"))).toBe(false);
    expect(isMemorable(field('{"type":"root"}', "RICH_TEXT_FIELD"))).toBe(false);
    expect(isMemorable(field("12345"))).toBe(false);
    expect(isMemorable(field("x".repeat(201)))).toBe(false);
  });
});

describe("reuseVerdict", () => {
  it("reuses a person's translation and a translation seen more than once", () => {
    expect(reuseVerdict(field("Used"), entry({ sourceText: "Used", targetText: "Rabljeno", origin: "manual" }), context)).toBe("reuse");
    expect(reuseVerdict(field("Used"), entry({ sourceText: "Used", targetText: "Rabljeno", usageCount: 2, resourceType: "COLLECTION" }), context)).toBe("reuse");
  });

  it("reuses the AI's single answer only for the same kind of content, else hints", () => {
    expect(reuseVerdict(field("Wing"), entry({ sourceText: "Wing", targetText: "Wing", resourceType: "LINK" }), context)).toBe("reuse");
    expect(reuseVerdict(field("Wing"), entry({ sourceText: "Wing", targetText: "Wing", resourceType: "PRODUCT" }), context)).toBe("hint");
  });

  it("never reuses for prose or long fields, and ignores an entry the glossary contradicts", () => {
    expect(reuseVerdict(field("<p>Wing</p>", "HTML"), entry({ sourceText: "Wing", targetText: "Wing", origin: "manual" }), context)).toBe("hint");
    const long = "A".repeat(121);
    expect(reuseVerdict(field(long), entry({ sourceText: long, targetText: "B", origin: "manual" }), context)).toBe("hint");
    const glossary: GlossaryTerm[] = [
      { kind: "translate", targetLocale: "sl", sourceTerm: "Foil", targetTerm: "Hidrokrilo" },
    ];
    expect(reuseVerdict(field("Foil"), entry({ sourceText: "Foil", targetText: "Foil", origin: "manual" }), { ...context, glossary })).toBe("ignore");
    expect(reuseVerdict(field("Foil"), entry({ sourceText: "Foil", targetText: "Hidrokrilo", origin: "manual" }), { ...context, glossary })).toBe("reuse");
    const protect: GlossaryTerm[] = [{ kind: "protect", targetLocale: null, sourceTerm: "SUP", targetTerm: null }];
    expect(reuseVerdict(field("SUP"), entry({ sourceText: "SUP", targetText: "Nad", origin: "manual" }), { ...context, glossary: protect })).toBe("ignore");
  });
});

describe("selectMemoryHints", () => {
  const entries: MemoryEntry[] = [
    entry({ id: "a", sourceText: "Wing", targetText: "Wing", usageCount: 30 }),
    entry({ id: "b", sourceText: "Carbon Mast", targetText: "Karbonski jambor", usageCount: 3 }),
    entry({ id: "c", sourceText: "Used", targetText: "Rabljeno", origin: "manual" }),
    entry({ id: "d", sourceText: "Boom", targetText: "Boom", usageCount: 1 }),
    entry({ id: "e", sourceText: "A long remembered sentence about wings and masts here", targetText: "…" }),
  ];

  it("offers the entries found inside the fields, a person's first, then by use", () => {
    const hints = selectMemoryHints(
      [field("Duotone Wing Unit with Carbon Mast — used once"), field("<p>Boomerang</p>", "HTML", "body_html")],
      entries,
      new Set(),
    );
    expect(hints.map((hint) => hint.id)).toEqual(["c", "a", "b"]);
  });

  it("excludes entries already used and respects the cap", () => {
    const hints = selectMemoryHints([field("Wing Carbon Mast Used")], entries, new Set(["a"]), 1);
    expect(hints.map((hint) => hint.id)).toEqual(["c"]);
  });
});

describe("memorablePairs", () => {
  it("keeps the short plain pairs that were written", () => {
    const fields = [field("Wing"), field("<p>Long</p>", "HTML", "body_html"), field("Used", "STRING", "label")];
    const values = new Map([
      ["title", "Wing"],
      ["body_html", "<p>Dolgo</p>"],
      ["label", "Rabljeno"],
    ]);
    expect(memorablePairs(fields, values)).toEqual([
      { key: "title", sourceText: "Wing", targetText: "Wing" },
      { key: "label", sourceText: "Used", targetText: "Rabljeno" },
    ]);
  });
});
