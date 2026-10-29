import type { AttributeSchema } from "~/domain/attributes/types";
import { KEYS, RIG_NAMESPACE } from "~/domain/rig/keys";

/**
 * Whether the plan already carries the attributes the engine places parts
 * with (docs/rig-builder.md, Product setup). A store with its own plan that
 * holds them does not need the example rig attributes, which would add a
 * second, unread set beside them.
 */

/** The keys that place a part in a rig, for the five roles readiness gates on. */
const PLACEMENT_KEYS: readonly string[] = [
  KEYS.canopyArea,
  KEYS.lengthCm,
  KEYS.mastDiameter,
  KEYS.boomMinCm,
  KEYS.boomMaxCm,
  KEYS.finBox,
  KEYS.volumeL,
  KEYS.finBoxTypes,
];

/** The placement keys the plan has no attribute for, in a fixed order. */
export function planMissingRigKeys(schema: AttributeSchema): string[] {
  const have = new Set(
    schema.attributes.map((attribute) => attribute.key.trim().toLowerCase()),
  );
  return PLACEMENT_KEYS.filter((key) => !have.has(`${RIG_NAMESPACE}.${key}`));
}

export function planCoversRig(schema: AttributeSchema): boolean {
  return planMissingRigKeys(schema).length === 0;
}
