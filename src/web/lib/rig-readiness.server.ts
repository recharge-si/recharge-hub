import { catalogueForCoverage } from "~/adapters/db/repositories/rig-catalogue.server";
import { coverage } from "~/domain/attributes/coverage";
import { RIG_COVERAGE_TYPES, RIG_TYPES } from "~/domain/attributes/rig-pack";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { Principal } from "~/domain/types";
import { readinessLines, type ReadinessLine } from "~/web/lib/rig-readiness";

/**
 * The rig readiness numbers for a shop (docs/attributes.md, Rig readiness).
 * Null when the plan holds none of the rig types, so a shop that never asked
 * for the pack pays for no catalogue read.
 */
export async function rigReadiness(
  principal: Principal,
  schema: AttributeSchema,
): Promise<ReadinessLine[] | null> {
  const present = RIG_TYPES.filter(
    (rig) =>
      RIG_COVERAGE_TYPES.includes(rig.id) &&
      schema.types.some(
        (type) => type.name.trim().toLowerCase() === rig.name.toLowerCase(),
      ),
  );
  if (present.length === 0) return null;
  const catalogue = await catalogueForCoverage(principal, schema);
  const lines = readinessLines(schema, coverage(schema, catalogue));
  return lines.length > 0 ? lines : null;
}

/** The products still missing rig data for one type, for the Products filter. */
export async function incompleteRigProducts(
  principal: Principal,
  schema: AttributeSchema,
  type: string,
): Promise<string[] | null> {
  if (!RIG_COVERAGE_TYPES.some((id) => id === type)) return null;
  const catalogue = await catalogueForCoverage(principal, schema);
  const found = coverage(schema, catalogue).find((c) => c.type === type);
  return found ? found.incomplete : null;
}
