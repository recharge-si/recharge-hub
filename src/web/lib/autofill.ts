/**
 * AI autofill in the merchant's words (docs/attributes.md § AI autofill).
 * Client-safe: the product page and the review list read from here.
 */

export type AutofillStatus =
  "queued" | "running" | "ready" | "applied" | "discarded" | "failed";

export interface AutofillView {
  status: AutofillStatus;
  typeId: string | null;
  /** `Windsurf › Sails › Wave sails`; null when no type, or one since deleted. */
  typePath: string | null;
  /** `suggested`: the AI chose it. `kept`: the product already had it. */
  typeOrigin: "suggested" | "kept" | null;
  confidence: number | null;
  reason: string | null;
  values: Array<{
    key: string;
    name: string;
    display: string;
    variantId: string | null;
  }>;
  error: string | null;
  /** Where the suggestion came from: `export-portal` or `claude-pool`; null on older rows. */
  source: string | null;
  /** The model that answered, when the producer reported one. */
  model: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/** Where a suggestion came from, in words; null for the portal's, which is the usual one. */
export function sourceLine(
  view: Pick<AutofillView, "source" | "model">,
): string | null {
  if (view.source !== "claude-pool") return null;
  return view.model
    ? `Suggested by Claude through the team pool (${view.model}).`
    : "Suggested by Claude through the team pool.";
}

export const isAutofillWorking = (view: AutofillView | null): boolean =>
  view?.status === "queued" || view?.status === "running";

/** "High" from 0.9, "medium" from 0.6, otherwise "low"; null when not said. */
export function confidenceLabel(confidence: number | null): string | null {
  if (confidence === null) return null;
  if (confidence >= 0.9) return "High confidence";
  if (confidence >= 0.6) return "Medium confidence";
  return "Low confidence";
}

export function confidenceTone(
  confidence: number | null,
): "success" | "warning" | "critical" | "neutral" {
  if (confidence === null) return "neutral";
  if (confidence >= 0.9) return "success";
  if (confidence >= 0.6) return "warning";
  return "critical";
}

/** A few words for a list: what is waiting for a person ("Wings + 2 values"). */
export function autofillSummary(view: AutofillView): string {
  const n = view.values.length;
  const values = `${n} ${n === 1 ? "value" : "values"}`;
  const type = view.typePath?.split(" › ").at(-1) ?? null;
  if (view.typeOrigin === "suggested" && type)
    return n > 0 ? `${type} + ${values}` : type;
  if (!view.typeId) return "No type fits";
  return n > 0 ? values : "Nothing to fill";
}
