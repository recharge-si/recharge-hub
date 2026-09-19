import { describe, expect, it } from "vitest";

import { fileNameFrom } from "~/web/components/download-button";

/**
 * The name a downloaded file is saved under comes from the response, so the
 * CSV route's `campaign-name-variants.csv` is what lands in the folder.
 */
describe("fileNameFrom", () => {
  it("reads the name out of Content-Disposition, quoted or not", () => {
    expect(
      fileNameFrom('attachment; filename="autumn-sale-variants.csv"', "x.csv"),
    ).toBe("autumn-sale-variants.csv");
    expect(fileNameFrom("attachment; filename=plain.csv", "x.csv")).toBe(
      "plain.csv",
    );
  });

  it("falls back when the header is missing or says nothing", () => {
    expect(fileNameFrom(null, "variants.csv")).toBe("variants.csv");
    expect(fileNameFrom("inline", "variants.csv")).toBe("variants.csv");
  });
});
