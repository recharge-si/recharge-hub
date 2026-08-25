import { describe, expect, it } from "vitest";

import { describeEvent } from "~/web/lib/activity";

/**
 * What the merchant reads on the products page after a sync.
 *
 * The wording under test replaced "39 products were rejected by MetaKocka and
 * were left alone" — true, and useless to someone who had just deleted a
 * pricelist in the ERP. CLAUDE.md §2.8 asks for what is wrong and how to fix
 * it, and §3 says MetaKocka's `opr_desc` is the only account of a failure there
 * is, so it is quoted rather than counted.
 */
const synced = (detail: Record<string, unknown>) =>
  describeEvent({ event: "products.synced", detail });

describe("product sync, described", () => {
  it("says nothing about failures when there were none", () => {
    const described = synced({ renamed: 4, created: 0, failed: 0 });

    expect(described.ok).toBe(true);
    expect(described.text).toBe(
      "Sent product names to MetaKocka: renamed 4 products.",
    );
  });

  it("quotes MetaKocka when products were rejected", () => {
    const described = synced({
      renamed: 0,
      failed: 39,
      reasons: [{ reason: "Product with code 'A-1' not found", count: 39 }],
    });

    expect(described.ok).toBe(false);
    expect(described.text).toContain("rejected 39 products");
    expect(described.text).toContain("Product with code 'A-1' not found");
  });

  it("leads with the deleted pricelist, and says names still went out", () => {
    const described = synced({
      renamed: 12,
      failed: 1,
      pricelistCode: "2",
      pricingStopped: "Pricelist '2' does not exist.",
      reasons: [{ reason: "Pricelist '2' does not exist.", count: 1 }],
    });

    expect(described.ok).toBe(false);
    expect(described.text).toContain("pricelist 2");
    expect(described.text).toContain("prices were not sent");
    expect(described.text).toContain("Pricelist '2' does not exist.");
  });

  it("falls back to a count when MetaKocka gave no description", () => {
    const described = synced({ failed: 2, reasons: [] });

    expect(described.ok).toBe(false);
    expect(described.text).toContain("rejected 2 products");
    expect(described.text).not.toContain("It said");
  });
});
