import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emptySchema, type AttributeSchema } from "~/domain/attributes/types";
import {
  candidatesFrom,
  type RigSnapshotProduct,
} from "~/domain/rig/candidates";
import { mergeProfile, type Answers } from "~/domain/rig/profile";
import { placeholderRules } from "~/domain/rig/rules";
import type { Profile, RigCandidate } from "~/domain/rig/types";

export const SHOP_A = "shop-a";
export const SHOP_B = "shop-b";

export const FIXTURES = join(process.cwd(), "tests", "fixtures", "rig");

/** The fixture catalogue (tests/fixtures/rig/catalogue.json): both shops, as snapshot rows. */
export function loadCatalogue(): RigSnapshotProduct[] {
  return JSON.parse(
    readFileSync(join(FIXTURES, "catalogue.json"), "utf8"),
  ) as RigSnapshotProduct[];
}

/**
 * A plan shaped like the store own: Windsurf with Boards and Sails as parents
 * of per-discipline leaves, and Masts, Booms, Mast extensions, Mast bases and
 * Fins as leaves. Wing boards sit beside, to prove they are not windsurf.
 */
export function rigPlan(): AttributeSchema {
  const plan = emptySchema();
  const type = (
    id: string,
    name: string,
    parentId: string | null,
    leaf: boolean,
  ) => ({
    id,
    name,
    parentId,
    leaf,
    sortOrder: 1000,
    shopifyCategory: "",
    archetype: "",
  });
  plan.types = [
    type("all", "All products", null, false),
    type("windsurf", "Windsurf", "all", false),
    type("boards", "Boards", "windsurf", false),
    type("sails", "Sails", "windsurf", false),
    ...["Freeride", "Wave", "Foil", "Beginner"].map((name) =>
      type(`${name.toLowerCase()}-boards`, `${name} boards`, "boards", true),
    ),
    ...["Freeride", "Wave", "Foil", "Beginner"].map((name) =>
      type(`${name.toLowerCase()}-sails`, `${name} sails`, "sails", true),
    ),
    ...["Masts", "Booms", "Mast extensions", "Mast bases", "Fins"].map((name) =>
      type(name.toLowerCase().replace(/ /g, "-"), name, "windsurf", true),
    ),
    type("wing", "Wing", "all", false),
    type("wing-boards", "Boards", "wing", true),
  ];
  return plan;
}

export function candidates(
  products: readonly RigSnapshotProduct[] = loadCatalogue(),
): RigCandidate[] {
  return candidatesFrom(rigPlan(), products);
}

export const rules = placeholderRules();

/** The PRD reference buyer: 82 kg, intermediate freeride, 15-25 knots. */
export const REFERENCE: Answers = {
  discipline: "windsurf",
  weightKg: 82,
  skill: "intermediate",
  windMinKn: 15,
  windMaxKn: 25,
  boardKind: "freeride",
};

export function profileOf(answers: Answers = REFERENCE): Profile {
  return mergeProfile(answers, undefined);
}

/** The products for which the predicate is false. */
export function without(
  products: readonly RigSnapshotProduct[],
  predicate: (product: RigSnapshotProduct) => boolean,
): RigSnapshotProduct[] {
  return products.filter((product) => !predicate(product));
}
