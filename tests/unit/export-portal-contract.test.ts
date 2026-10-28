import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldSchema, sourceSchema } from "~/domain/export-portal/contract";

/**
 * The contract's strictness and its description (docs/sources.md § The
 * contract). The portal is the side that gets fixed when it sends something
 * this schema refuses; the schema is not loosened to hide a portal bug.
 */
const DOC = readFileSync(resolve(process.cwd(), "docs/sources.md"), "utf8");

describe("docs/sources.md Shapes", () => {
  const shapes = /### Shapes\s+```ts\n([\s\S]*?)```/.exec(DOC)?.[1] ?? "";
  const fieldLines = shapes
    .split("\n")
    .filter((line) => line.startsWith("Field "))
    .join("\n");

  it("has a Shapes block with a Field line", () => {
    expect(fieldLines).not.toBe("");
  });

  it.each(Object.keys(fieldSchema.shape))(
    "names the field member `%s` that contract.ts accepts",
    (key) => {
      expect(fieldLines).toMatch(new RegExp(`\\b${key}\\??[,\\s}]`));
    },
  );
});

describe("sourceSchema.portalUrl", () => {
  const base = {
    id: "sc_1",
    name: "A source",
    kind: "own_source:x",
    kindLabel: "Feed x",
    enabled: true,
    schedule: { mode: "manual" },
    health: "ok",
    fields: [],
    values: {},
  };

  it("accepts the key being absent (the portal omits it when its return URL is unset or relative)", () => {
    expect(sourceSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an absolute https URL", () => {
    expect(
      sourceSchema.safeParse({
        ...base,
        portalUrl: "https://portal.example/shopify",
      }).success,
    ).toBe(true);
  });

  it.each(["/shopify", "/", "portal.example/shopify", ""])(
    "still rejects %j: the portal is the one that is fixed",
    (portalUrl) => {
      expect(sourceSchema.safeParse({ ...base, portalUrl }).success).toBe(false);
    },
  );
});
