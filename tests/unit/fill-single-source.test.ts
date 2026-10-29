import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rigPack } from "~/domain/attributes/rig-pack";
import { attributeFields } from "~/domain/products/attribute-values";
import {
  suggestedValues,
  valuesAnswerSchema,
} from "~/domain/products/autofill";
import { parseFillReply } from "~/domain/products/fill";

/**
 * docs/attributes.md § Bulk filling with claude-pool: the portal path and the
 * claude-pool path ask for the same attributes and check answers with the
 * same function, so one place decides what a suggestion is.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("one definition of the rules", () => {
  const files = [...sources("src"), ...sources("scripts")];

  it.each(["attributesToFill", "suggestedValues"])(
    "%s is defined once, in domain/products/autofill.ts",
    (name) => {
      const definers = files.filter((file) =>
        new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=)`).test(
          readFileSync(file, "utf8"),
        ),
      );
      expect(definers).toEqual([
        join("src", "domain", "products", "autofill.ts"),
      ]);
    },
  );

  it("both producers import them from there", () => {
    const portal = readFileSync(
      join("src", "adapters", "products", "autofill.server.ts"),
      "utf8",
    );
    const bulk = readFileSync(
      join("src", "adapters", "products", "fill-runner.server.ts"),
      "utf8",
    );
    expect(portal).toMatch(
      /attributesToFill[\s\S]*from "~\/domain\/products\/autofill"/,
    );
    expect(portal).toMatch(
      /suggestedValues[\s\S]*from "~\/domain\/products\/autofill"/,
    );
    expect(bulk).toMatch(
      /attributesToFill[\s\S]*from "~\/domain\/products\/autofill"/,
    );
    expect(bulk).toMatch(/from "~\/domain\/products\/fill"/);
  });
});

describe("the same model reply stores the same suggestion", () => {
  const plan = rigPack();
  const type = plan.types.find((t) => t.name === "Masts")!;
  const fields = attributeFields(plan, type.id, {
    definitions: new Map(),
    product: {},
    variants: [],
  });
  const reply = JSON.stringify({
    values: [
      { attributeId: "rig_mast_rdm", value: "RDM 30" },
      { attributeId: "rig_mast_imcs", value: "21 IMCS" },
      { attributeId: "rig_mast_length_cm", variantId: "v1", value: "430" },
      { attributeId: "rig_mast_carbon_percent", value: "85-90" },
    ],
  });

  it("is byte-identical in storage", () => {
    const portal = suggestedValues(
      fields,
      {},
      ["v1"],
      valuesAnswerSchema.parse(JSON.parse(reply)),
    );
    const pool = parseFillReply(reply, fields, {}, ["v1"]);
    expect(pool.valid).toBe(true);
    expect(JSON.stringify(pool.valid ? pool.values : null)).toBe(
      JSON.stringify(portal),
    );
    expect(portal.map((v) => v.key)).toEqual([
      "rig_mast_rdm",
      "rig_mast_imcs",
      "rig_mast_length_cm@v1",
    ]);
  });
});
