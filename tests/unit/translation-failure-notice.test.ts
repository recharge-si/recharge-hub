import { describe, expect, it } from "vitest";

import {
  translationFailureKey,
  translationFailureMessage,
} from "~/domain/translations/failure-notice";

/** The Needs attention row for a resource that could not be translated (docs/translations.md § Failures). */
describe("translation failure notice", () => {
  it("names the resource, the language and the reason", () => {
    expect(
      translationFailureMessage("Duotone Rebel", [
        { locale: "sl", error: "The reply left out title." },
      ]),
    ).toBe(
      "“Duotone Rebel” could not be translated into Slovenian. The reply left out title.",
    );
  });

  it("states one reason once for every language that failed with it", () => {
    expect(
      translationFailureMessage("Kite", [
        { locale: "sl", error: "The provider answered 500" },
        { locale: "de", error: "The provider answered 500" },
      ]),
    ).toBe(
      "“Kite” could not be translated into Slovenian and German. The provider answered 500.",
    );
  });

  it("gives each language its own reason when they differ", () => {
    expect(
      translationFailureMessage("Kite", [
        { locale: "sl", error: "The reply left out title." },
        { locale: "de", error: null },
      ]),
    ).toBe(
      "“Kite” could not be translated into Slovenian and German. Slovenian: The reply left out title. German: No reason was recorded.",
    );
  });

  it("keys the row by resource, so repeated failures update one row", () => {
    expect(translationFailureKey("gid://shopify/Product/1")).toBe(
      "translation-resource:gid://shopify/Product/1",
    );
  });
});
