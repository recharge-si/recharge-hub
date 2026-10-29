import { loadRigSource } from "~/adapters/db/repositories/rig.server";
import type { AttributeSchema } from "~/domain/attributes/types";
import { rigReadiness as engineReadiness } from "~/domain/rig/candidates";
import type { Principal } from "~/domain/types";
import {
  readinessLines,
  roleOfType,
  type ReadinessLine,
} from "~/web/lib/rig-readiness";

/**
 * The rig readiness numbers for a shop (docs/rig-builder.md, Readiness), from
 * the same candidates the engine builds rigs from. Null when the plan makes
 * no product a rig part.
 */
export async function rigReadiness(
  principal: Principal,
  schema: AttributeSchema,
): Promise<ReadinessLine[] | null> {
  const source = await loadRigSource(principal);
  const lines = readinessLines(
    schema,
    engineReadiness(source.plan, source.products),
  );
  return lines.length > 0 ? lines : null;
}

/** The products still missing rig data for one role, for the Products filter. */
export async function incompleteRigProducts(
  principal: Principal,
  _schema: AttributeSchema,
  type: string,
): Promise<string[] | null> {
  const role = roleOfType(type);
  if (!role) return null;
  const source = await loadRigSource(principal);
  return engineReadiness(source.plan, source.products).roles[role].incomplete;
}
