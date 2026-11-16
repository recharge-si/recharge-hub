import { describe, expect, it } from "vitest";

import { fieldSchema, type Field } from "~/domain/export-portal/contract";
import {
  renderTokens,
  tokenError,
  tokenPreview,
  tokenRegistry,
  tokenRows,
} from "~/web/lib/portal-field-tokens";

/**
 * A portal text field that takes `{fields}` — today the title prefix — and
 * how the pattern editor is fed from it.
 *
 * The portal renders the same pattern with its own port of the parser
 * (`titlePattern.js`); the cases in "renders like the portal" are the ones
 * that port was checked against, so a preview here is the title pushed there.
 */

const TOKENS = [
  { key: "vendor", label: "Vendor", example: "Dakine" },
  { key: "product_type", label: "Product type", example: null },
  { key: "category", label: "Category", example: "Neoprene" },
  { key: "subcategory", label: "Subcategory", example: "Impact vests" },
  { key: "code", label: "Product code", example: "UF-1" },
];

const FIELD: Field = fieldSchema.parse({
  key: "titlePrefix",
  label: "Title prefix",
  type: "text",
  tokens: TOKENS,
  sample: { label: "UF-1", after: "Seeker Vest" },
});

describe("portal field tokens", () => {
  it("reads tokens and a sample off a field; a field without them still parses", () => {
    expect(FIELD.tokens).toHaveLength(5);
    expect(FIELD.sample).toEqual({ label: "UF-1", after: "Seeker Vest" });
    const plain = fieldSchema.parse({ key: "a", label: "A", type: "text" });
    expect(plain.tokens).toBeUndefined();
    expect(plain.sample).toBeUndefined();
  });

  it("offers each field as a chip with its example, and no invented one", () => {
    expect(tokenRegistry(TOKENS)[0]).toEqual({
      id: "vendor",
      label: "Vendor",
      group: "product",
    });
    const [group] = tokenRows(TOKENS, "");
    expect(group?.rows.map((r) => [r.field.id, r.value])).toContainEqual([
      "product_type",
      null,
    ]);
    expect(tokenRows(TOKENS, "zzz")).toEqual([]);
  });

  it("renders like the portal", () => {
    expect(renderTokens("{vendor} -", TOKENS)).toBe("Dakine -");
    expect(renderTokens("{category|upper} -", TOKENS)).toBe("NEOPRENE -");
    expect(renderTokens("{category} [{subcategory} ]-", TOKENS)).toBe(
      "Neoprene Impact vests -",
    );
    expect(renderTokens("{vendor} | {product_type} -", TOKENS)).toBe(
      "Dakine -",
    );
    expect(renderTokens('{product_type|suffix:" -"}', TOKENS)).toBe("");
    expect(renderTokens("{code}:", TOKENS)).toBe("UF-1:");
    expect(renderTokens("WINDSURF -", TOKENS)).toBe("WINDSURF -");
  });

  it("previews the sample product the way the MetaKocka name does", () => {
    expect(tokenPreview(FIELD, "{vendor} -")).toBe(
      "UF-1: Dakine - Seeker Vest",
    );
    expect(tokenPreview(FIELD, "")).toBeNull();
    const { sample: _sample, ...withoutSample } = FIELD;
    expect(tokenPreview(withoutSample, "{vendor} -")).toBeNull();
  });

  it("names a field or filter the portal would refuse", () => {
    expect(tokenError(FIELD, "{vendor|upper} -")).toBeNull();
    expect(tokenError(FIELD, "{colour} -")).toBe(
      "{colour} is not a field this setting can use.",
    );
    expect(tokenError(FIELD, "{vendor|shout}")).toMatch(/not a filter/);
  });
});
