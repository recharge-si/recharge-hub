import type { AutofillState } from "~/adapters/db/repositories/product-autofill.server";
import { pathOf } from "~/domain/attributes/resolve";
import type { AttributeSchema } from "~/domain/attributes/types";
import type { AutofillView } from "~/web/lib/autofill";

/**
 * A product's AI autofill state as the pages show it (docs/attributes.md
 * § AI autofill): the type by its path, dates as strings, nothing a page
 * does not use.
 */
export function autofillView(
  schema: AttributeSchema,
  state: AutofillState | null | undefined,
): AutofillView | null {
  if (!state) return null;
  const known = state.typeId
    ? schema.types.some((type) => type.id === state.typeId)
    : false;
  return {
    status: state.status,
    typeId: state.typeId,
    typePath:
      state.typeId && known ? pathOf(schema, state.typeId).join(" › ") : null,
    typeOrigin: state.typeOrigin,
    confidence: state.typeConfidence,
    reason: state.typeReason,
    values: state.values.map((value) => ({
      key: value.key,
      name: value.name,
      display: value.display,
      variantId: value.variantId,
    })),
    error: state.error,
    source: state.source,
    model: state.model,
    requestedAt: state.requestedAt.toISOString(),
    decidedAt: state.decidedAt?.toISOString() ?? null,
  };
}
